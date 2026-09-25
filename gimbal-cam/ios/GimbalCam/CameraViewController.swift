import AVFoundation
import AVKit
import UIKit

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

final class CameraViewController: UIViewController {

    private let engine = CameraEngine()
    private let keyMap = GimbalKeyMap()

    private let preview = PreviewView()
    private let statusLabel = PillLabel()
    private let zoomLabel = PillLabel()
    private let lastInputLabel = PillLabel()
    private let recordButton = RecordButton()
    private let setupButton = CameraViewController.roundButton(symbol: "gearshape")
    private let flipButton = CameraViewController.roundButton(symbol: "arrow.triangle.2.circlepath.camera")
    private let stopButton = CameraViewController.roundButton(symbol: "stop.fill")
    private let setupPanel = UIView()
    private let setupRows = UIStackView()
    private let setupLastInput = PillLabel()

    private var clockTimer: Timer?
    private var hideLastInput: DispatchWorkItem?
    private var recordHold: DispatchWorkItem?
    private var recordHoldFired = false
    private var zoomRampStart: DispatchWorkItem?
    /// Action waiting for its gimbal control in the setup panel, or nil when not learning.
    private var learning: GimbalAction?

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    override var canBecomeFirstResponder: Bool { true }

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUI()
        installVolumeButtonHandling()

        engine.onChange = { [weak self] in self?.render() }
        engine.onMessage = { [weak self] in self?.toast($0) }
        requestAccess { [weak self] granted in
            guard let self else { return }
            if granted {
                self.engine.configure(previewLayer: self.preview.previewLayer)
            } else {
                self.statusLabel.text = "Camera access is off — enable it in Settings"
            }
        }
        clockTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.render()
        }
        render()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    private func requestAccess(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { video in
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { done(video) }
            }
        }
    }

    // MARK: Gimbal input

    /// Bluetooth camera remotes, gimbals included, usually press "volume up" for the shutter.
    /// AVCaptureEventInteraction is Apple's supported way for a camera app to receive those
    /// presses (and Camera Control on iPhone 16+) without the volume changing.
    private func installVolumeButtonHandling() {
        guard #available(iOS 17.2, *) else { return }
        let interaction = AVCaptureEventInteraction(
            primary: { [weak self] event in self?.handleCaptureEvent(.volumeDown, phase: event.phase) },
            secondary: { [weak self] event in self?.handleCaptureEvent(.volumeUp, phase: event.phase) }
        )
        view.addInteraction(interaction)
    }

    @available(iOS 17.2, *)
    private func handleCaptureEvent(_ input: GimbalInput, phase: AVCaptureEventPhase) {
        switch phase {
        case .began: inputDown(input)
        case .ended, .cancelled: inputUp(input)
        @unknown default: break
        }
    }

    /// Keyboard-style HID keys (Enter, arrows, Page Up/Down…).
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandled = Set<UIPress>()
        for press in presses {
            if let key = press.key, handlesKey(key.keyCode.rawValue, down: true) { continue }
            unhandled.insert(press)
        }
        if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandled = Set<UIPress>()
        for press in presses {
            if let key = press.key, handlesKey(key.keyCode.rawValue, down: false) { continue }
            unhandled.insert(press)
        }
        if !unhandled.isEmpty { super.pressesEnded(unhandled, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        pressesEnded(presses, with: event)
    }

    private func handlesKey(_ code: Int, down: Bool) -> Bool {
        let input = GimbalInput.key(code)
        // Unknown keys are still shown (and learnable) but otherwise passed on.
        guard keyMap.action(for: input) != nil || learning != nil || !setupPanel.isHidden else {
            if down { showLastInput(input) }
            return false
        }
        if down { inputDown(input) } else { inputUp(input) }
        return true
    }

    private func inputDown(_ input: GimbalInput) {
        showLastInput(input)
        if let action = learning {
            keyMap.assign(input, to: action)
            learning = nil
            renderSetup()
            return
        }
        guard setupPanel.isHidden, let action = keyMap.action(for: input) else { return }
        switch action {
        case .record:
            recordHoldFired = false
            let hold = DispatchWorkItem { [weak self] in
                self?.recordHoldFired = true
                self?.engine.stop()
            }
            recordHold = hold
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: hold)
        case .zoomIn: startZoom(+1)
        case .zoomOut: startZoom(-1)
        case .stop: engine.stop()
        case .flip: engine.flipCamera()
        }
    }

    private func inputUp(_ input: GimbalInput) {
        guard setupPanel.isHidden, let action = keyMap.action(for: input) else { return }
        switch action {
        case .record:
            guard let hold = recordHold else { return }
            hold.cancel()
            recordHold = nil
            if !recordHoldFired { engine.toggleRecord() }
            recordHoldFired = false
        case .zoomIn, .zoomOut:
            stopZoom()
        default:
            break
        }
    }

    private func startZoom(_ direction: Int) {
        zoomRampStart?.cancel()
        engine.zoomStep(direction)
        let ramp = DispatchWorkItem { [weak self] in self?.engine.startZoomRamp(direction) }
        zoomRampStart = ramp
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: ramp)
    }

    private func stopZoom() {
        zoomRampStart?.cancel()
        zoomRampStart = nil
        engine.stopZoomRamp()
    }

    private func showLastInput(_ input: GimbalInput) {
        let action = keyMap.action(for: input)?.label ?? "not assigned"
        let text = "\(input.name) → \(action)"
        lastInputLabel.text = text
        setupLastInput.text = text
        lastInputLabel.isHidden = false
        hideLastInput?.cancel()
        let hide = DispatchWorkItem { [weak self] in self?.lastInputLabel.isHidden = true }
        hideLastInput = hide
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: hide)
    }

    // MARK: Rendering

    private func render() {
        let seconds = Int(engine.recordedSeconds)
        let clock = String(format: "%02d:%02d", seconds / 60, seconds % 60)
        switch engine.state {
        case .idle:
            statusLabel.text = "READY"
            statusLabel.textColor = .white
        case .recording:
            statusLabel.text = "● REC  \(clock)"
            statusLabel.textColor = .systemRed
        case .paused:
            statusLabel.text = "❚❚ PAUSED  \(clock)"
            statusLabel.textColor = .systemOrange
        case .saving:
            statusLabel.text = "SAVING…"
            statusLabel.textColor = .white
        }
        zoomLabel.text = String(format: "%.1f×", engine.displayZoom)
        recordButton.mode = engine.state == .recording ? .pause : (engine.state == .paused ? .resume : .record)
        let open = engine.state != .idle
        stopButton.isHidden = !open
        // Fade Flip rather than hide it: a hidden stack-view item collapses, and Stop is pinned
        // to where Flip sits.
        flipButton.alpha = open ? 0 : 1
        flipButton.isEnabled = !open
    }

    private func toast(_ message: String) {
        let label = PillLabel()
        label.text = message
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.bottomAnchor.constraint(equalTo: recordButton.topAnchor, constant: -24),
        ])
        UIView.animate(withDuration: 0.3, delay: 2.2, options: []) { label.alpha = 0 } completion: { _ in
            label.removeFromSuperview()
        }
    }

    // MARK: UI construction

    private func buildUI() {
        preview.previewLayer.videoGravity = .resizeAspect
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        preview.addGestureRecognizer(pinch)

        recordButton.addTarget(self, action: #selector(recordTapped), for: .touchUpInside)
        stopButton.addTarget(self, action: #selector(stopTapped), for: .touchUpInside)
        flipButton.addTarget(self, action: #selector(flipTapped), for: .touchUpInside)
        setupButton.addTarget(self, action: #selector(openSetup), for: .touchUpInside)
        lastInputLabel.isHidden = true
        lastInputLabel.font = .systemFont(ofSize: 12, weight: .medium)

        let topBar = UIStackView(arrangedSubviews: [statusLabel, UIView(), zoomLabel])
        topBar.axis = .horizontal
        topBar.alignment = .center

        let bottomBar = UIStackView(arrangedSubviews: [setupButton, recordButton, flipButton])
        bottomBar.axis = .horizontal
        bottomBar.alignment = .center
        bottomBar.spacing = 36

        for v in [preview, topBar, lastInputLabel, bottomBar, stopButton] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            preview.topAnchor.constraint(equalTo: view.topAnchor),
            preview.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            preview.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            preview.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            topBar.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
            topBar.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
            topBar.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),

            lastInputLabel.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 12),
            lastInputLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            lastInputLabel.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 16),

            bottomBar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -20),
            recordButton.widthAnchor.constraint(equalToConstant: 80),
            recordButton.heightAnchor.constraint(equalToConstant: 80),

            // Stop sits exactly where Flip is; only one of them shows at a time.
            stopButton.centerXAnchor.constraint(equalTo: flipButton.centerXAnchor),
            stopButton.centerYAnchor.constraint(equalTo: flipButton.centerYAnchor),
        ])
        buildSetupPanel()
    }

    private func buildSetupPanel() {
        setupPanel.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        setupPanel.isHidden = true
        setupPanel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(setupPanel)

        let card = UIStackView()
        card.axis = .vertical
        card.spacing = 12
        card.isLayoutMarginsRelativeArrangement = true
        card.layoutMargins = UIEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        card.backgroundColor = UIColor(white: 0.08, alpha: 0.95)
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false

        let title = UILabel()
        title.text = "Gimbal buttons"
        title.font = .systemFont(ofSize: 22, weight: .bold)
        title.textColor = .white

        let help = UILabel()
        help.text = "Connect the gimbal in DJI Mimo first, then switch to Gimbal Cam. You can leave Mimo running in the background. To teach a control, tap Learn next to it, then press or roll that control on the gimbal. Hold the record button about a second to stop and save."
        help.numberOfLines = 0
        help.font = .systemFont(ofSize: 14)
        help.textColor = UIColor(white: 1, alpha: 0.75)

        setupLastInput.text = "Waiting for a gimbal button…"
        setupRows.axis = .vertical
        setupRows.spacing = 8

        let reset = UIButton(type: .system)
        reset.setTitle("Reset", for: .normal)
        reset.addTarget(self, action: #selector(resetKeys), for: .touchUpInside)
        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        done.addTarget(self, action: #selector(closeSetup), for: .touchUpInside)
        let buttons = UIStackView(arrangedSubviews: [reset, UIView(), done])
        buttons.axis = .horizontal

        for v in [title, help, setupLastInput, setupRows, buttons] { card.addArrangedSubview(v) }
        setupPanel.addSubview(card)

        NSLayoutConstraint.activate([
            setupPanel.topAnchor.constraint(equalTo: view.topAnchor),
            setupPanel.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            setupPanel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            setupPanel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            card.centerYAnchor.constraint(equalTo: setupPanel.centerYAnchor),
            card.leadingAnchor.constraint(equalTo: setupPanel.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            card.trailingAnchor.constraint(equalTo: setupPanel.safeAreaLayoutGuide.trailingAnchor, constant: -16),
        ])
    }

    private func renderSetup() {
        setupRows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for action in GimbalAction.allCases {
            let label = UILabel()
            let inputs = keyMap.inputs(for: action)
            label.numberOfLines = 0
            label.textColor = .white
            label.font = .systemFont(ofSize: 15)
            label.text = action.label + "\n" +
                (inputs.isEmpty ? "no button" : inputs.map(\.name).joined(separator: ", "))
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let learn = UIButton(type: .system)
            learn.setTitle(learning == action ? "Press it…" : "Learn", for: .normal)
            learn.setContentHuggingPriority(.required, for: .horizontal)
            learn.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                self.learning = self.learning == action ? nil : action
                self.renderSetup()
            }, for: .touchUpInside)

            let row = UIStackView(arrangedSubviews: [label, learn])
            row.axis = .horizontal
            row.alignment = .center
            row.spacing = 12
            setupRows.addArrangedSubview(row)
        }
    }

    // MARK: Actions

    @objc private func recordTapped() { engine.toggleRecord() }
    @objc private func stopTapped() { engine.stop() }
    @objc private func flipTapped() { engine.flipCamera() }

    @objc private func openSetup() {
        learning = nil
        renderSetup()
        setupPanel.isHidden = false
    }

    @objc private func closeSetup() {
        learning = nil
        setupPanel.isHidden = true
        becomeFirstResponder()
    }

    @objc private func resetKeys() {
        keyMap.reset()
        learning = nil
        renderSetup()
    }

    private var pinchStartZoom: CGFloat = 1
    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        guard let device = (preview.previewLayer.session?.inputs
            .compactMap { $0 as? AVCaptureDeviceInput }
            .first { $0.device.hasMediaType(.video) })?.device else { return }
        if pinch.state == .began { pinchStartZoom = device.videoZoomFactor }
        engine.setZoom(pinchStartZoom * pinch.scale)
    }

    private static func roundButton(symbol: String) -> UIButton {
        let button = UIButton(type: .system)
        let config = UIImage.SymbolConfiguration(pointSize: 20, weight: .medium)
        button.setImage(UIImage(systemName: symbol, withConfiguration: config), for: .normal)
        button.tintColor = .white
        button.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        button.layer.cornerRadius = 28
        button.layer.borderWidth = 1
        button.layer.borderColor = UIColor(white: 1, alpha: 0.3).cgColor
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 56).isActive = true
        button.heightAnchor.constraint(equalToConstant: 56).isActive = true
        return button
    }
}

/// Rounded translucent label used for status, zoom and hints.
final class PillLabel: UILabel {
    override init(frame: CGRect) {
        super.init(frame: frame)
        textColor = .white
        font = .monospacedDigitSystemFont(ofSize: 15, weight: .bold)
        backgroundColor = UIColor.black.withAlphaComponent(0.55)
        layer.cornerRadius = 14
        layer.masksToBounds = true
        numberOfLines = 0
        textAlignment = .center
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 24, height: max(size.height + 10, 28))
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 12, dy: 5))
    }
}

/// The big shutter: red dot to record, red square with ❚❚ while recording, dot with ▶ when paused.
final class RecordButton: UIControl {
    enum Mode { case record, pause, resume }

    var mode: Mode = .record {
        didSet { if mode != oldValue { setNeedsLayout() } }
    }

    private let ring = CAShapeLayer()
    private let inner = CAShapeLayer()
    private let glyph = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        ring.fillColor = UIColor.clear.cgColor
        ring.strokeColor = UIColor.white.cgColor
        ring.lineWidth = 4
        inner.fillColor = UIColor.systemRed.cgColor
        layer.addSublayer(ring)
        layer.addSublayer(inner)
        glyph.textColor = .white
        glyph.font = .systemFont(ofSize: 24, weight: .bold)
        glyph.textAlignment = .center
        glyph.isUserInteractionEnabled = false
        addSubview(glyph)
        accessibilityLabel = "Record"
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let b = bounds
        ring.path = UIBezierPath(ovalIn: b.insetBy(dx: 2, dy: 2)).cgPath
        switch mode {
        case .pause:
            let r = b.insetBy(dx: b.width * 0.29, dy: b.height * 0.29)
            inner.path = UIBezierPath(roundedRect: r, cornerRadius: 6).cgPath
            glyph.text = "❚❚"
            glyph.font = .systemFont(ofSize: 16, weight: .bold)
            accessibilityLabel = "Pause"
        case .resume:
            inner.path = UIBezierPath(ovalIn: b.insetBy(dx: 9, dy: 9)).cgPath
            glyph.text = "▶"
            glyph.font = .systemFont(ofSize: 24, weight: .bold)
            accessibilityLabel = "Resume"
        case .record:
            inner.path = UIBezierPath(ovalIn: b.insetBy(dx: 9, dy: 9)).cgPath
            glyph.text = nil
            accessibilityLabel = "Record"
        }
        glyph.frame = b
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }
}
