#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#define NAPI_VERSION 8
#include <node_api.h>

static SPUUpdater *updater;
static NSString *phase = @"idle";
static NSString *version = @"";
static NSString *displayVersion = @"";
static NSString *message = @"";
static NSString *errorMessage = @"";
static NSInteger errorCode = 0;
static uint64_t receivedBytes = 0;
static uint64_t totalBytes = 0;
static double progress = 0;
static BOOL cancelRequested = NO;
static void (^checkOrDownloadCancellation)(void);
static void (^availableReply)(SPUUserUpdateChoice);
static void (^readyReply)(SPUUserUpdateChoice);

static void ClearReplies(void) {
  checkOrDownloadCancellation = nil;
  availableReply = nil;
  readyReply = nil;
}

static void SetError(NSError *error) {
  phase = @"error";
  errorCode = error.code;
  errorMessage = error.localizedDescription ?: @"Unable to update the application";
  message = errorMessage;
}

@interface GuziSparkleDriver : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@end

@implementation GuziSparkleDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO automaticUpdateDownloading:@NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  phase = @"checking";
  checkOrDownloadCancellation = [cancellation copy];
  if (cancelRequested) { checkOrDownloadCancellation = nil; cancellation(); }
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  checkOrDownloadCancellation = nil;
  version = item.versionString ?: @"";
  displayVersion = item.displayVersionString ?: version;
  if (cancelRequested) { reply(SPUUserUpdateChoiceDismiss); return; }
  if (item.informationOnlyUpdate) {
    SetError([NSError errorWithDomain:@"GuziSparkleBridge" code:1002 userInfo:@{NSLocalizedDescriptionKey: @"This update requires a manual download"}]);
    reply(SPUUserUpdateChoiceDismiss);
    return;
  }
  // Automatic installation is disabled in Info.plist. Preserve explicit user control if a resumed state is encountered.
  if (state.stage == SPUUserUpdateStageInstalling) {
    cancelRequested = YES;
    reply(SPUUserUpdateChoiceSkip);
    return;
  }
  phase = @"available";
  message = @"Update available";
  availableReply = [reply copy];
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  phase = cancelRequested ? @"cancelled" : @"latest";
  message = cancelRequested ? @"Update cancelled" : @"The application is up to date";
  acknowledgement();
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  if (!cancelRequested) SetError(error);
  acknowledgement();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  phase = @"downloading";
  message = @"Downloading update";
  checkOrDownloadCancellation = [cancellation copy];
  if (cancelRequested) { checkOrDownloadCancellation = nil; cancellation(); }
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length {
  totalBytes = length;
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
  receivedBytes += length;
  progress = totalBytes > 0 ? fmin(1.0, (double)receivedBytes / totalBytes) : 0;
}
- (void)showDownloadDidStartExtractingUpdate {
  checkOrDownloadCancellation = nil;
  phase = @"verifying";
  message = cancelRequested ? @"Cancelling update" : @"Verifying update";
  progress = 0;
}
- (void)showExtractionReceivedProgress:(double)value {
  progress = fmax(0.0, fmin(1.0, value));
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  // Sparkle can install on ordinary termination from this point. A queued cancellation must reach its installer first.
  if (cancelRequested) { reply(SPUUserUpdateChoiceSkip); return; }
  phase = @"ready";
  message = @"Ready to install";
  progress = 1;
  readyReply = [reply copy];
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
  phase = @"installing";
  message = @"Installing update";
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
  acknowledgement();
}
- (void)dismissUpdateInstallation {
  ClearReplies();
  if (cancelRequested) { phase = @"cancelled"; message = @"Update cancelled"; }
  else if (![phase isEqualToString:@"error"] && ![phase isEqualToString:@"latest"]) phase = @"idle";
}
- (void)updater:(SPUUpdater *)sender didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
  ClearReplies();
  if (cancelRequested) { phase = @"cancelled"; message = @"Update cancelled"; }
  else if (error && ![phase isEqualToString:@"latest"] && ![phase isEqualToString:@"error"]) SetError(error);
}
@end

static GuziSparkleDriver *driver;

static BOOL ValidateCall(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok) return NO;
  if (argc != 0) { napi_throw_type_error(env, nullptr, "Sparkle bridge methods take no arguments"); return NO; }
  if (![NSThread isMainThread]) { napi_throw_error(env, nullptr, "Sparkle must run on the application main thread"); return NO; }
  return YES;
}

static napi_value MakeBoolean(napi_env env, BOOL value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  if (!ValidateCall(env, info)) return nullptr;
  if (updater) return MakeBoolean(env, YES);
  driver = [GuziSparkleDriver new];
  SPUUpdater *candidate = [[SPUUpdater alloc] initWithHostBundle:NSBundle.mainBundle applicationBundle:NSBundle.mainBundle userDriver:driver delegate:driver];
  NSError *error = nil;
  if (![candidate startUpdater:&error]) {
    SetError(error ?: [NSError errorWithDomain:@"GuziSparkleBridge" code:1001 userInfo:@{NSLocalizedDescriptionKey: @"Unable to start the updater"}]);
    return MakeBoolean(env, NO);
  }
  updater = candidate;
  phase = @"idle";
  errorMessage = @"";
  errorCode = 0;
  message = @"";
  return MakeBoolean(env, YES);
}

static napi_value Check(napi_env env, napi_callback_info info) {
  if (!ValidateCall(env, info)) return nullptr;
  if (!updater || updater.sessionInProgress || !updater.canCheckForUpdates) return MakeBoolean(env, NO);
  ClearReplies();
  cancelRequested = NO;
  receivedBytes = totalBytes = 0;
  progress = 0;
  errorCode = 0;
  errorMessage = @"";
  version = displayVersion = @"";
  phase = @"checking";
  message = @"Checking for updates";
  [updater checkForUpdates];
  return MakeBoolean(env, YES);
}

static napi_value Download(napi_env env, napi_callback_info info) {
  if (!ValidateCall(env, info)) return nullptr;
  if (!availableReply || cancelRequested) return MakeBoolean(env, NO);
  void (^reply)(SPUUserUpdateChoice) = availableReply;
  availableReply = nil;
  phase = @"downloading";
  message = @"Downloading update";
  reply(SPUUserUpdateChoiceInstall);
  return MakeBoolean(env, YES);
}

static napi_value Install(napi_env env, napi_callback_info info) {
  if (!ValidateCall(env, info)) return nullptr;
  if (!readyReply || cancelRequested) return MakeBoolean(env, NO);
  void (^reply)(SPUUserUpdateChoice) = readyReply;
  readyReply = nil;
  phase = @"installing";
  message = @"Installing update";
  reply(SPUUserUpdateChoiceInstall);
  return MakeBoolean(env, YES);
}

static napi_value Cancel(napi_env env, napi_callback_info info) {
  if (!ValidateCall(env, info)) return nullptr;
  if (updater.sessionInProgress && ![phase isEqualToString:@"installing"]) {
    cancelRequested = YES;
    message = @"Cancelling update";
    if (readyReply) {
      void (^reply)(SPUUserUpdateChoice) = readyReply;
      readyReply = nil;
      reply(SPUUserUpdateChoiceSkip);
    } else if (availableReply) {
      void (^reply)(SPUUserUpdateChoice) = availableReply;
      availableReply = nil;
      reply(SPUUserUpdateChoiceDismiss);
    } else if (checkOrDownloadCancellation) {
      void (^cancel)(void) = checkOrDownloadCancellation;
      checkOrDownloadCancellation = nil;
      cancel();
    }
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Status(napi_env env, napi_callback_info info) {
  if (!ValidateCall(env, info)) return nullptr;
  NSDictionary *snapshot = @{
    @"phase": phase, @"version": version, @"displayVersion": displayVersion, @"notes": @"",
    @"receivedBytes": @(receivedBytes), @"totalBytes": @(totalBytes), @"progress": @(progress),
    @"error": errorMessage, @"message": message, @"code": @(errorCode),
    @"sessionInProgress": @(updater.sessionInProgress),
    @"canCheck": @(updater && !updater.sessionInProgress && updater.canCheckForUpdates), @"ready": @(readyReply != nil)
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil];
  napi_value result;
  napi_create_string_utf8(env, (const char *)data.bytes, data.length, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"check", nullptr, Check, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"download", nullptr, Download, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"install", nullptr, Install, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
