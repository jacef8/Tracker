import AVFoundation
import Photos
import UIKit

/// Owns the capture session and the recording.
///
/// iOS's AVCaptureMovieFileOutput has no pause, so a paused recording is kept as a list of
/// segments: pausing closes the current segment file, resuming opens a new one, and stopping
/// joins them into one video (without re-encoding) and saves it to Photos.
final class CameraEngine: NSObject {

    enum State: Equatable { case idle, recording, paused, saving }

    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "gimbalcam.session")
    private let movieOutput = AVCaptureMovieFileOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var previewRotationObservation: NSKeyValueObservation?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var position: AVCaptureDevice.Position = .back

    // Recording state, touched only on the main queue.
    private(set) var state: State = .idle { didSet { onChange?() } }
    private var segments: [URL] = []
    private var segmentsInFlight = 0
    private var finishedDuration: TimeInterval = 0
    private var segmentStartedAt: Date?
    private var resumeWhenSegmentCloses = false
    private var stopRequested = false
    private var recordingRotationAngle: CGFloat?

    /// Called on the main queue whenever state or zoom changes.
    var onChange: (() -> Void)?
    /// Called on the main queue with a short message for the user.
    var onMessage: ((String) -> Void)?

    var recordedSeconds: TimeInterval {
        finishedDuration + (segmentStartedAt.map { Date().timeIntervalSince($0) } ?? 0)
    }

    // MARK: Setup

    func configure(previewLayer: AVCaptureVideoPreviewLayer) {
        self.previewLayer = previewLayer
        previewLayer.session = session
        sessionQueue.async {
            self.session.beginConfiguration()
            if self.session.canSetSessionPreset(.hd1920x1080) {
                self.session.sessionPreset = .hd1920x1080
            } else {
                self.session.sessionPreset = .high
            }
            self.installVideoInput(position: .back)
            if let mic = AVCaptureDevice.default(for: .audio),
               let micInput = try? AVCaptureDeviceInput(device: mic),
               self.session.canAddInput(micInput) {
                self.session.addInput(micInput)
            }
            if self.session.canAddOutput(self.movieOutput) {
                self.session.addOutput(self.movieOutput)
            }
            self.session.commitConfiguration()
            self.session.startRunning()
            DispatchQueue.main.async {
                self.setUpRotation()
                self.resetZoom()
            }
        }
    }

    /// Picks the multi-lens virtual camera when there is one, so zooming slides across the
    /// ultra-wide, wide and telephoto lenses the way the built-in Camera does.
    private func bestDevice(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let types: [AVCaptureDevice.DeviceType] = position == .back
            ? [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera]
            : [.builtInTrueDepthCamera, .builtInWideAngleCamera]
        let found = AVCaptureDevice.DiscoverySession(
            deviceTypes: types, mediaType: .video, position: position
        ).devices
        for type in types {
            if let device = found.first(where: { $0.deviceType == type }) { return device }
        }
        return nil
    }

    /// Must run on sessionQueue inside begin/commitConfiguration.
    private func installVideoInput(position: AVCaptureDevice.Position) {
        guard let device = bestDevice(position: position),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        if let old = videoInput { session.removeInput(old) }
        if session.canAddInput(input) {
            session.addInput(input)
            videoInput = input
            self.position = position
        } else if let old = videoInput, session.canAddInput(old) {
            session.addInput(old)
        }
        if let connection = movieOutput.connection(with: .video),
           connection.isVideoStabilizationSupported {
            connection.preferredVideoStabilizationMode = .auto
        }
    }

    func flipCamera() {
        guard state == .idle else { return }
        let next: AVCaptureDevice.Position = position == .back ? .front : .back
        sessionQueue.async {
            self.session.beginConfiguration()
            self.installVideoInput(position: next)
            self.session.commitConfiguration()
            DispatchQueue.main.async {
                self.setUpRotation()
                self.resetZoom()
            }
        }
    }

    /// Keeps the preview upright and the recorded video level, however the phone is turned.
    private func setUpRotation() {
        guard let device = videoInput?.device, let layer = previewLayer else { return }
        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
        rotationCoordinator = coordinator
        layer.connection?.videoRotationAngle = coordinator.videoRotationAngleForHorizonLevelPreview
        previewRotationObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelPreview, options: .new
        ) { [weak layer] coordinator, _ in
            DispatchQueue.main.async {
                layer?.connection?.videoRotationAngle = coordinator.videoRotationAngleForHorizonLevelPreview
            }
        }
    }

    // MARK: Recording: one press starts, the next pauses, the next resumes

    func toggleRecord() {
        switch state {
        case .idle: start()
        case .recording: pause()
        case .paused: resume()
        case .saving: break
        }
    }

    private func start() {
        segments = []
        finishedDuration = 0
        stopRequested = false
        resumeWhenSegmentCloses = false
        // Every segment must share one orientation or they can't be joined, so lock it now.
        recordingRotationAngle = rotationCoordinator?.videoRotationAngleForHorizonLevelCapture
        state = .recording
        openSegment()
    }

    private func pause() {
        state = .paused
        closeSegment()
    }

    private func resume() {
        state = .recording
        if pendingClose {
            // The previous segment is still being written; open the next one when it's done.
            resumeWhenSegmentCloses = true
        } else {
            openSegment()
        }
    }

    func stop() {
        guard state == .recording || state == .paused else { return }
        stopRequested = true
        resumeWhenSegmentCloses = false
        state = .saving
        if segmentStartedAt != nil { closeSegment() } else { finishIfDone() }
    }

    /// True between asking the output to stop and hearing that the file is finished.
    private var pendingClose = false

    private func openSegment() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("segment-\(UUID().uuidString).mov")
        let angle = recordingRotationAngle
        segmentsInFlight += 1
        segmentStartedAt = Date()
        sessionQueue.async {
            if let connection = self.movieOutput.connection(with: .video), let angle,
               connection.isVideoRotationAngleSupported(angle) {
                connection.videoRotationAngle = angle
            }
            self.movieOutput.startRecording(to: url, recordingDelegate: self)
        }
    }

    private func closeSegment() {
        if let started = segmentStartedAt {
            finishedDuration += Date().timeIntervalSince(started)
        }
        segmentStartedAt = nil
        pendingClose = true
        sessionQueue.async { self.movieOutput.stopRecording() }
    }

    private func segmentClosed(url: URL, error: Error?) {
        segmentsInFlight -= 1
        let expected = pendingClose
        pendingClose = false
        let usable: Bool = {
            guard let error = error as NSError? else { return true }
            // A file can finish "with an error" and still be complete, e.g. disk nearly full.
            return (error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) == true
        }()
        if usable {
            segments.append(url)
        } else {
            try? FileManager.default.removeItem(at: url)
            onMessage?("A clip couldn't be recorded")
        }

        // The camera stopped by itself (app sent to background, phone call…): keep what was
        // recorded and treat it as paused, so the next press carries on in the same video.
        if !expected, let started = segmentStartedAt {
            finishedDuration += Date().timeIntervalSince(started)
            segmentStartedAt = nil
            if state == .recording {
                state = .paused
                onMessage?("Paused — the camera was interrupted")
            }
        }

        if resumeWhenSegmentCloses {
            resumeWhenSegmentCloses = false
            openSegment()
            return
        }
        finishIfDone()
    }

    private func finishIfDone() {
        guard stopRequested, segmentsInFlight == 0 else { return }
        stopRequested = false
        let parts = segments
        segments = []
        Task { await self.joinAndSave(parts) }
    }

    private func joinAndSave(_ parts: [URL]) async {
        defer {
            for url in parts { try? FileManager.default.removeItem(at: url) }
        }
        do {
            guard !parts.isEmpty else { throw CameraError.nothingRecorded }
            let finalURL: URL
            if parts.count == 1 {
                finalURL = parts[0]
            } else {
                finalURL = try await CameraEngine.join(parts)
            }
            try await CameraEngine.saveToPhotos(finalURL)
            if finalURL != parts.first { try? FileManager.default.removeItem(at: finalURL) }
            await MainActor.run {
                self.state = .idle
                self.finishedDuration = 0
                self.onMessage?("Saved to Photos")
            }
        } catch {
            await MainActor.run {
                self.state = .idle
                self.finishedDuration = 0
                self.onMessage?("Couldn't save: \(error.localizedDescription)")
            }
        }
    }

    enum CameraError: LocalizedError {
        case nothingRecorded, exportFailed(String), photosDenied
        var errorDescription: String? {
            switch self {
            case .nothingRecorded: return "nothing was recorded"
            case .exportFailed(let why): return "joining clips failed (\(why))"
            case .photosDenied: return "Photos access is off. Turn it on in Settings › Gimbal Cam."
            }
        }
    }

    /// Joins the segments end to end without re-encoding.
    private static func join(_ parts: [URL]) async throws -> URL {
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else { throw CameraError.exportFailed("no video track") }
        var audioTrack: AVMutableCompositionTrack?
        var cursor = CMTime.zero

        for (index, url) in parts.enumerated() {
            let asset = AVURLAsset(url: url)
            let duration = try await asset.load(.duration)
            let range = CMTimeRange(start: .zero, duration: duration)
            if let sourceVideo = try await asset.loadTracks(withMediaType: .video).first {
                try videoTrack.insertTimeRange(range, of: sourceVideo, at: cursor)
                if index == 0 {
                    videoTrack.preferredTransform = try await sourceVideo.load(.preferredTransform)
                }
            }
            if let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first {
                if audioTrack == nil {
                    audioTrack = composition.addMutableTrack(
                        withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
                    )
                }
                try audioTrack?.insertTimeRange(range, of: sourceAudio, at: cursor)
            }
            cursor = cursor + duration
        }

        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("GimbalCam-\(UUID().uuidString).mov")
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw CameraError.exportFailed("export unavailable")
        }
        export.outputURL = out
        export.outputFileType = .mov
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            export.exportAsynchronously { done.resume() }
        }
        guard export.status == .completed else {
            throw CameraError.exportFailed(export.error?.localizedDescription ?? "status \(export.status.rawValue)")
        }
        return out
    }

    private static func saveToPhotos(_ url: URL) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw CameraError.photosDenied }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
        }
    }

    // MARK: Zoom

    private var device: AVCaptureDevice? { videoInput?.device }

    /// Zoom factor the UI calls "1×": the main wide lens, even on a multi-lens camera whose
    /// raw factor 1.0 is the ultra-wide.
    private var wideLensFactor: CGFloat {
        guard let device, device.isVirtualDevice,
              device.constituentDevices.contains(where: { $0.deviceType == .builtInUltraWideCamera }),
              let first = device.virtualDeviceSwitchOverVideoZoomFactors.first
        else { return 1 }
        return CGFloat(truncating: first)
    }

    private var maxZoom: CGFloat {
        guard let device else { return 1 }
        // Past ~10× of the wide lens it's digital mush; cap there.
        return min(device.maxAvailableVideoZoomFactor, wideLensFactor * 10)
    }

    private var minZoom: CGFloat { device?.minAvailableVideoZoomFactor ?? 1 }

    /// Current zoom as the user thinks of it (0.5×, 1×, 2×…).
    var displayZoom: CGFloat {
        guard let device else { return 1 }
        return device.videoZoomFactor / wideLensFactor
    }

    func resetZoom() {
        setZoom(wideLensFactor)
    }

    func setZoom(_ factor: CGFloat) {
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = max(minZoom, min(factor, maxZoom))
            device.unlockForConfiguration()
        } catch {}
        onChange?()
    }

    /// One detent of the gimbal wheel / one tap of a zoom key.
    func zoomStep(_ direction: Int) {
        guard let device else { return }
        let factor: CGFloat = 1.12
        setZoom(direction > 0 ? device.videoZoomFactor * factor : device.videoZoomFactor / factor)
    }

    /// Smooth zoom while a control is held; call stopZoomRamp() on release.
    func startZoomRamp(_ direction: Int) {
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            device.ramp(toVideoZoomFactor: direction > 0 ? maxZoom : minZoom, withRate: 1.6)
            device.unlockForConfiguration()
        } catch {}
    }

    func stopZoomRamp() {
        guard let device else { return }
        do {
            try device.lockForConfiguration()
            device.cancelVideoZoomRamp()
            device.unlockForConfiguration()
        } catch {}
        onChange?()
    }
}

extension CameraEngine: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection]
    ) {
        // A pause pressed in the instant before the file really started would otherwise be
        // lost (stopping a recording that hasn't begun does nothing), so repeat it now.
        DispatchQueue.main.async {
            if self.pendingClose { self.sessionQueue.async { self.movieOutput.stopRecording() } }
        }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        DispatchQueue.main.async { self.segmentClosed(url: outputFileURL, error: error) }
    }
}
