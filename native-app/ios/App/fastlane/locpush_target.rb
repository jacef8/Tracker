# Adds the LocationPush app extension target to App.xcodeproj (iOS 1.0.17).
#
# There is no Mac on this project's side of the fence -- every iOS build runs on a GitHub cloud
# Mac -- so the extension target cannot be added in Xcode and committed. Instead the Fastfile
# calls this during the build, before signing. It is idempotent: a project that already has the
# target is only brought up to date (bundle id, versions, files), never duplicated.
#
# Sources live in the repo: ios/App/LocationPush/{LocationPushService.swift, Info.plist,
# LocationPush.entitlements}, plus ios/App/App/GLShared.swift, which BOTH targets compile.
require 'xcodeproj'

module LocPushTarget
  NAME = 'LocationPush'.freeze
  BUNDLE_ID = 'com.groundlink.ios.locpush'.freeze

  def self.ensure!(project_path, build_number)
    project = Xcodeproj::Project.open(project_path)
    app = project.targets.find { |t| t.name == 'App' } or raise 'no App target'

    # The app's own marketing version: the extension must carry the same one or App Store
    # Connect rejects the upload (CFBundleShortVersionString mismatch).
    marketing = app.build_configurations.first.build_settings['MARKETING_VERSION'] or raise 'App has no MARKETING_VERSION'

    # GLShared.swift is in the App group on disk; make sure the App target compiles it.
    app_group = project.main_group.find_subpath('App', false) or raise 'no App group'
    shared_ref = app_group.files.find { |f| f.path == 'GLShared.swift' } || app_group.new_reference('GLShared.swift')
    app.add_file_references([shared_ref]) unless app.source_build_phase.files_references.include?(shared_ref)

    ext = project.targets.find { |t| t.name == NAME }
    unless ext
      ext = project.new_target(:app_extension, NAME, :ios, '15.0', nil, :swift)
      grp = project.main_group.find_subpath(NAME, true)
      grp.set_source_tree('<group>')
      grp.set_path(NAME)
      svc = grp.new_reference('LocationPushService.swift')
      grp.new_reference('Info.plist')
      grp.new_reference('LocationPush.entitlements')
      ext.add_file_references([svc, shared_ref])

      # Embed the extension in the app (PlugIns) and build it first.
      app.add_dependency(ext)
      embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
              app.new_copy_files_build_phase('Embed Foundation Extensions')
      embed.symbol_dst_subfolder_spec = :plug_ins
      bf = embed.add_file_reference(ext.product_reference, true)
      bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
    end

    ext.build_configurations.each do |c|
      s = c.build_settings
      s['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID
      s['PRODUCT_NAME'] = '$(TARGET_NAME)'
      s['INFOPLIST_FILE'] = 'LocationPush/Info.plist'
      s['GENERATE_INFOPLIST_FILE'] = 'NO'
      s['CODE_SIGN_ENTITLEMENTS'] = 'LocationPush/LocationPush.entitlements'
      s['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
      s['SWIFT_VERSION'] = '5.0'
      s['TARGETED_DEVICE_FAMILY'] = '1,2'
      s['SKIP_INSTALL'] = 'YES'
      s['MARKETING_VERSION'] = marketing
      s['CURRENT_PROJECT_VERSION'] = build_number.to_s
      s['DEVELOPMENT_TEAM'] = 'XM3MLRA366'
      s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    end

    project.save
    UI.message("LocationPush target ready (#{BUNDLE_ID}, #{marketing} (#{build_number}))") if defined?(UI)
  end
end
