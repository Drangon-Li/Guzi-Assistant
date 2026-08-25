#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

static AXObserverRef activeObserver = NULL;
static AXUIElementRef activeApplication = NULL;
static AXUIElementRef activeFocusedElement = NULL;
static pid_t activePid = 0;
static BOOL activeAccessibilityAvailable = NO;
static NSMutableDictionary<NSString *, NSNumber *> *bundleBackoffUntil = nil;
static BOOL inputMonitoringObserved = NO;
static NSUInteger inputBurstLength = 0;
static BOOL inputBurstSecure = NO;
static NSString *inputBurstAppName = @"";
static NSString *inputBurstBundleId = @"";
static NSString *inputBurstWindowTitle = @"";
static NSString *inputBurstURLHost = @"";
static NSString *inputBurstTargetRole = @"";
static NSString *inputBurstTargetSubrole = @"";
static pid_t inputBurstPid = 0;
static CGWindowID inputBurstWindowId = 0;
static BOOL dragging = NO;
static BOOL dragMoved = NO;
static NSPoint dragOrigin = { 0, 0 };
static pid_t lastWindowPid = 0;
static CGWindowID lastWindowId = 0;
static NSString *lastWindowTitle = @"";

static NSString *trimmed(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return @"";
  return [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static long long nowMs(void) {
  return (long long)(NSDate.date.timeIntervalSince1970 * 1000.0);
}

static NSString *bundleKey(NSRunningApplication *application) {
  return application.bundleIdentifier.length ? application.bundleIdentifier : @"<unknown>";
}

static BOOL bundleBackedOff(NSRunningApplication *application) {
  if (!bundleBackoffUntil) bundleBackoffUntil = [NSMutableDictionary dictionary];
  NSNumber *until = bundleBackoffUntil[bundleKey(application)];
  return until != nil && until.longLongValue > nowMs();
}

static void noteBundleFailure(NSRunningApplication *application) {
  if (!bundleBackoffUntil) bundleBackoffUntil = [NSMutableDictionary dictionary];
  NSString *key = bundleKey(application);
  NSNumber *until = bundleBackoffUntil[key];
  long long previousUntil = until.longLongValue;
  long long delay = previousUntil > nowMs() ? MIN((long long)60000, (previousUntil - nowMs()) * 2) : 1000;
  bundleBackoffUntil[key] = @(nowMs() + MAX((long long)1000, delay));
}

static void noteBundleSuccess(NSRunningApplication *application) {
  if (bundleBackoffUntil) [bundleBackoffUntil removeObjectForKey:bundleKey(application)];
}

static BOOL secureRole(NSString *role) {
  if ([role caseInsensitiveCompare:@"AXSecureTextField"] == NSOrderedSame) return YES;
  return role.length > 0 && [role rangeOfString:@"secure|password|secret" options:(NSRegularExpressionSearch | NSCaseInsensitiveSearch)].location != NSNotFound;
}

static NSArray<NSString *> *modifierNames(NSEventModifierFlags flags) {
  NSMutableArray<NSString *> *result = [NSMutableArray array];
  if (flags & NSEventModifierFlagCommand) [result addObject:@"command"];
  if (flags & NSEventModifierFlagControl) [result addObject:@"control"];
  if (flags & NSEventModifierFlagOption) [result addObject:@"option"];
  if (flags & NSEventModifierFlagShift) [result addObject:@"shift"];
  if (flags & NSEventModifierFlagFunction) [result addObject:@"function"];
  return result;
}

static NSString *inputMonitoringStatus(id monitor) {
  if (!monitor || !CGPreflightListenEventAccess()) return @"unavailable";
  return inputMonitoringObserved ? @"available" : @"unknown";
}

static NSString *attributeString(AXUIElementRef element, CFStringRef attribute, AXError *errorOut) {
  if (errorOut) *errorOut = kAXErrorNoValue;
  if (!element) return @"";
  AXUIElementSetMessagingTimeout(element, 0.25);
  CFTypeRef raw = NULL;
  AXError result = AXUIElementCopyAttributeValue(element, attribute, &raw);
  if (errorOut) *errorOut = result;
  if (result != kAXErrorSuccess || !raw) {
    if (raw) CFRelease(raw);
    return @"";
  }
  NSString *value = CFGetTypeID(raw) == CFStringGetTypeID() ? [(__bridge NSString *)raw copy] : @"";
  CFRelease(raw);
  return trimmed(value);
}

static NSString *urlHostForElement(AXUIElementRef element) {
  if (!element) return @"";
  AXUIElementSetMessagingTimeout(element, 0.25);
  CFTypeRef raw = NULL;
  AXError result = AXUIElementCopyAttributeValue(element, kAXURLAttribute, &raw);
  if (result != kAXErrorSuccess || !raw) {
    if (raw) CFRelease(raw);
    return @"";
  }
  NSURL *url = nil;
  if (CFGetTypeID(raw) == CFURLGetTypeID()) {
    url = (__bridge NSURL *)raw;
  } else if (CFGetTypeID(raw) == CFStringGetTypeID()) {
    url = [NSURL URLWithString:(__bridge NSString *)raw];
  }
  NSString *scheme = url.scheme.lowercaseString;
  NSString *host = url.host.lowercaseString;
  NSString *safeHost = ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) && host.length
    ? (host.length > 255 ? [host substringToIndex:255] : host)
    : @"";
  CFRelease(raw);
  return safeHost;
}

static NSString *urlHostForFocusedWindow(void) {
  if (!activeApplication) return @"";
  AXUIElementSetMessagingTimeout(activeApplication, 0.25);
  CFTypeRef rawWindow = NULL;
  AXError result = AXUIElementCopyAttributeValue(activeApplication, kAXFocusedWindowAttribute, &rawWindow);
  if (result != kAXErrorSuccess || !rawWindow) {
    if (rawWindow) CFRelease(rawWindow);
    return @"";
  }
  AXUIElementRef windowElement = (AXUIElementRef)rawWindow;
  NSString *host = urlHostForElement(windowElement);
  CFRelease(rawWindow);
  return host;
}

static BOOL isBrowserApplication(NSRunningApplication *application) {
  NSString *bundle = application.bundleIdentifier.lowercaseString;
  return [bundle isEqualToString:@"com.apple.safari"] ||
    [bundle isEqualToString:@"com.google.chrome"] ||
    [bundle isEqualToString:@"com.microsoft.edgemac"] ||
    [bundle isEqualToString:@"org.mozilla.firefox"];
}

static CGWindowID windowNumberForPid(pid_t pid) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  ));
  for (NSDictionary *window in windows) {
    NSNumber *ownerPid = window[(id)kCGWindowOwnerPID];
    NSNumber *layer = window[(id)kCGWindowLayer];
    if (ownerPid.intValue != pid || layer.intValue != 0) continue;
    NSNumber *windowNumber = window[(id)kCGWindowNumber];
    if (windowNumber != nil) return (CGWindowID)windowNumber.unsignedIntValue;
  }
  return 0;
}

static NSString *windowTitleForPid(pid_t pid) {
  NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  ));
  for (NSDictionary *window in windows) {
    NSNumber *ownerPid = window[(id)kCGWindowOwnerPID];
    NSNumber *layer = window[(id)kCGWindowLayer];
    if (ownerPid.intValue != pid || layer.intValue != 0) continue;
    NSString *title = trimmed(window[(id)kCGWindowName]);
    if (title.length > 0) return title.length > 160 ? [title substringToIndex:160] : title;
  }
  return @"";
}

static void emit(NSDictionary *payload) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  if (!json) return;
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static NSDictionary *baseContext(NSRunningApplication *application) {
  pid_t pid = application ? application.processIdentifier : 0;
  return @{
    @"appName": application.localizedName ?: @"",
    @"bundleId": application.bundleIdentifier ?: @"",
    @"windowTitle": windowTitleForPid(pid),
    @"occurredAtMs": @(nowMs())
  };
}

static void emitActivity(NSString *type, NSRunningApplication *application, NSDictionary *extra) {
  if (!application && ![type isEqualToString:@"heartbeat"]) return;
  NSMutableDictionary *payload = [baseContext(application) mutableCopy];
  payload[@"type"] = type;
  payload[@"accessibility"] = activeAccessibilityAvailable ? @"available" : @"unavailable";
  if (extra) [payload addEntriesFromDictionary:extra];
  emit(payload);
}

static NSString *activeFocusedRole(void) {
  if (!activeApplication) return @"";
  AXUIElementSetMessagingTimeout(activeApplication, 0.25);
  AXUIElementRef focused = NULL;
  AXUIElementCopyAttributeValue(activeApplication, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
  NSString *role = attributeString(focused, kAXRoleAttribute, NULL);
  if (focused) CFRelease(focused);
  return role;
}

static NSString *activeFocusedSubrole(void) {
  if (!activeApplication) return @"";
  AXUIElementSetMessagingTimeout(activeApplication, 0.25);
  AXUIElementRef focused = NULL;
  AXUIElementCopyAttributeValue(activeApplication, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
  NSString *subrole = attributeString(focused, kAXSubroleAttribute, NULL);
  if (focused) CFRelease(focused);
  return subrole;
}

static BOOL activeFocusedIsSecure(NSRunningApplication *application) {
  // A stale AX element or a timeout is treated as secure. The collector must
  // never turn an unclassified key burst into a normal persisted event.
  if (!application || !activeApplication || activePid != application.processIdentifier) return YES;
  AXUIElementSetMessagingTimeout(activeApplication, 0.25);
  AXUIElementRef focused = NULL;
  AXError focusResult = AXUIElementCopyAttributeValue(activeApplication, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
  if (focusResult != kAXErrorSuccess || !focused) {
    if (focused) CFRelease(focused);
    return YES;
  }
  AXError roleResult = kAXErrorNoValue;
  AXError subroleResult = kAXErrorNoValue;
  NSString *role = attributeString(focused, kAXRoleAttribute, &roleResult);
  NSString *subrole = attributeString(focused, kAXSubroleAttribute, &subroleResult);
  // AXSubrole is optional on ordinary controls, but a missing/invalid role
  // leaves the input target unclassified and must fail closed.
  BOOL unavailable = roleResult != kAXErrorSuccess ||
    (subroleResult != kAXErrorSuccess && subroleResult != kAXErrorNoValue);
  BOOL secure = unavailable || role.length == 0 || secureRole(role) || secureRole(subrole);
  CFRelease(focused);
  return secure;
}

static NSString *activeFocusedURLHost(NSRunningApplication *application) {
  if (!isBrowserApplication(application)) return @"";
  if (!activeApplication) return @"";
  AXUIElementSetMessagingTimeout(activeApplication, 0.25);
  AXUIElementRef focused = NULL;
  AXUIElementCopyAttributeValue(activeApplication, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
  NSString *host = urlHostForElement(focused);
  if (!host.length) host = urlHostForFocusedWindow();
  if (focused) CFRelease(focused);
  return host;
}

static void clearAccessibilityObserver(void) {
  if (activeObserver && activeApplication) {
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXFocusedWindowChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXFocusedUIElementChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXTitleChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXValueChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXSelectedTextChangedNotification);
    if (activeFocusedElement) {
      AXObserverRemoveNotification(activeObserver, activeFocusedElement, kAXTitleChangedNotification);
      AXObserverRemoveNotification(activeObserver, activeFocusedElement, kAXValueChangedNotification);
      AXObserverRemoveNotification(activeObserver, activeFocusedElement, kAXSelectedTextChangedNotification);
    }
    CFRunLoopSourceRef source = AXObserverGetRunLoopSource(activeObserver);
    if (source) CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
  }
  if (activeObserver) CFRelease(activeObserver);
  if (activeApplication) CFRelease(activeApplication);
  if (activeFocusedElement) CFRelease(activeFocusedElement);
  activeObserver = NULL;
  activeApplication = NULL;
  activeFocusedElement = NULL;
  activePid = 0;
  activeAccessibilityAvailable = NO;
}

static void observeFocusedElement(AXUIElementRef focused) {
  if (!activeObserver || focused == activeFocusedElement) return;
  if (activeFocusedElement) {
    AXObserverRemoveNotification(activeObserver, activeFocusedElement, kAXTitleChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeFocusedElement, kAXValueChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeFocusedElement, kAXSelectedTextChangedNotification);
    CFRelease(activeFocusedElement);
    activeFocusedElement = NULL;
  }
  if (!focused) return;
  activeFocusedElement = (AXUIElementRef)CFRetain(focused);
  AXObserverAddNotification(activeObserver, activeFocusedElement, kAXTitleChangedNotification, NULL);
  AXObserverAddNotification(activeObserver, activeFocusedElement, kAXValueChangedNotification, NULL);
  AXObserverAddNotification(activeObserver, activeFocusedElement, kAXSelectedTextChangedNotification, NULL);
}

static void emitFocusedMetadata(NSString *type, NSRunningApplication *application) {
  if (!activeApplication || !application) return;
  AXUIElementSetMessagingTimeout(activeApplication, 0.25);
  AXUIElementRef focused = NULL;
  AXError focusResult = AXUIElementCopyAttributeValue(activeApplication, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
  AXError roleResult = kAXErrorNoValue;
  AXError subroleResult = kAXErrorNoValue;
  AXError titleResult = kAXErrorNoValue;
  AXError descriptionResult = kAXErrorNoValue;
  NSString *role = attributeString(focused, kAXRoleAttribute, &roleResult);
  NSString *subrole = attributeString(focused, kAXSubroleAttribute, &subroleResult);
  NSString *title = attributeString(focused, kAXTitleAttribute, &titleResult);
  if (!title.length) title = attributeString(focused, kAXDescriptionAttribute, &descriptionResult);
  BOOL roleAvailable = roleResult == kAXErrorSuccess;
  BOOL subroleAvailable = subroleResult == kAXErrorSuccess || subroleResult == kAXErrorNoValue;
  BOOL focusAvailable = focusResult == kAXErrorSuccess;
  BOOL timedOut = focusResult == kAXErrorCannotComplete || roleResult == kAXErrorCannotComplete ||
    subroleResult == kAXErrorCannotComplete || titleResult == kAXErrorCannotComplete ||
    descriptionResult == kAXErrorCannotComplete;
  BOOL accessibility = focusAvailable && roleAvailable && subroleAvailable && !timedOut;
  if (!accessibility) {
    activeAccessibilityAvailable = NO;
    noteBundleFailure(application);
  } else {
    activeAccessibilityAvailable = YES;
  }
  observeFocusedElement(focused);
  BOOL secure = !accessibility || secureRole(role) || secureRole(subrole);
  NSString *urlHost = activeFocusedURLHost(application);
  NSMutableDictionary *payload = [baseContext(application) mutableCopy];
  payload[@"type"] = type;
  payload[@"focusedRole"] = role;
  payload[@"focusedSubrole"] = subrole;
  payload[@"targetRole"] = role;
  payload[@"targetSubrole"] = subrole;
  payload[@"safeLabel"] = secure ? @"" : (title.length > 160 ? [title substringToIndex:160] : title);
  payload[@"secureInput"] = @(secure);
  if (urlHost.length) payload[@"urlHost"] = urlHost;
  payload[@"accessibility"] = accessibility ? @"available" : @"unavailable";
  emit(payload);
  if (focused) CFRelease(focused);
}

static void accessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void *refcon) {
  (void)observer; (void)element; (void)refcon;
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:activePid];
  if (!application) return;
  NSString *name = (__bridge NSString *)notification;
  NSString *type = [name isEqualToString:(__bridge NSString *)kAXFocusedUIElementChangedNotification]
    ? @"ax_focus_changed"
    : [name isEqualToString:(__bridge NSString *)kAXSelectedTextChangedNotification]
      ? @"selection_changed"
      : @"ax_attribute_changed";
  emitFocusedMetadata(type, application);
}

static BOOL attachAccessibility(NSRunningApplication *application) {
  clearAccessibilityObserver();
  if (!application || !AXIsProcessTrusted() || bundleBackedOff(application)) return NO;
  pid_t pid = application.processIdentifier;
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  if (!appElement) return NO;
  AXObserverRef observer = NULL;
  if (AXObserverCreate(pid, accessibilityCallback, &observer) != kAXErrorSuccess || !observer) {
    CFRelease(appElement);
    noteBundleFailure(application);
    return NO;
  }
  CFStringRef notifications[] = {
    kAXFocusedWindowChangedNotification,
    kAXFocusedUIElementChangedNotification,
    kAXTitleChangedNotification,
    kAXValueChangedNotification,
    kAXSelectedTextChangedNotification
  };
  for (NSUInteger i = 0; i < sizeof(notifications) / sizeof(notifications[0]); i++)
    AXObserverAddNotification(observer, appElement, notifications[i], NULL);
  CFRunLoopSourceRef source = AXObserverGetRunLoopSource(observer);
  if (source) CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
  activeObserver = observer;
  activeApplication = appElement;
  activePid = pid;
  activeAccessibilityAvailable = YES;
  noteBundleSuccess(application);
  return YES;
}

static void emitApplicationEvent(NSRunningApplication *application) {
  if (!application) return;
  BOOL accessibility = attachAccessibility(application);
  emitActivity(@"app_activated", application, @{ @"accessibility": accessibility ? @"available" : @"unavailable" });
  lastWindowPid = application.processIdentifier;
  lastWindowId = windowNumberForPid(application.processIdentifier);
  lastWindowTitle = windowTitleForPid(application.processIdentifier);
  if (accessibility) emitFocusedMetadata(@"ax_focus_changed", application);
}

static void emitWindowChangeIfNeeded(NSRunningApplication *application) {
  if (!application) return;
  CGWindowID windowId = windowNumberForPid(application.processIdentifier);
  NSString *title = windowTitleForPid(application.processIdentifier);
  if (application.processIdentifier == lastWindowPid && windowId == lastWindowId && [title isEqualToString:lastWindowTitle]) return;
  lastWindowPid = application.processIdentifier;
  lastWindowId = windowId;
  lastWindowTitle = title;
  NSMutableDictionary *extra = [NSMutableDictionary dictionary];
  if (windowId > 0) extra[@"windowId"] = @(windowId);
  NSString *urlHost = activeFocusedURLHost(application);
  if (urlHost.length) extra[@"urlHost"] = urlHost;
  emitActivity(@"window_changed", application, extra);
}

@interface Collector : NSObject
@property(nonatomic, strong) id globalMonitor;
@property(nonatomic, strong) NSTimer *inputTimer;
- (void)handleGlobalEvent:(NSEvent *)event;
- (void)flushInputBurst;
- (void)beginInputBurst:(NSRunningApplication *)front;
- (void)resetInputBurst;
@end

@implementation Collector
- (void)emitInteraction:(NSString *)type command:(NSString *)command modifiers:(NSArray<NSString *> *)modifiers inputLength:(NSNumber *)length secure:(BOOL)secure {
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front) return;
  NSMutableDictionary *extra = [NSMutableDictionary dictionary];
  if (command) extra[@"command"] = command;
  if (modifiers) extra[@"modifiers"] = modifiers;
  if (length) extra[@"inputLength"] = length;
  if (secure) extra[@"secureInput"] = @YES;
  extra[@"targetRole"] = activeFocusedRole();
  extra[@"targetSubrole"] = activeFocusedSubrole();
  NSString *urlHost = activeFocusedURLHost(front);
  if (urlHost.length) extra[@"urlHost"] = urlHost;
  extra[@"inputMonitoring"] = inputMonitoringStatus(self.globalMonitor);
  emitActivity(type, front, extra);
}

- (void)beginInputBurst:(NSRunningApplication *)front {
  inputBurstAppName = front.localizedName ?: @"";
  inputBurstBundleId = front.bundleIdentifier ?: @"";
  inputBurstPid = front ? front.processIdentifier : 0;
  inputBurstWindowTitle = windowTitleForPid(inputBurstPid);
  inputBurstWindowId = windowNumberForPid(inputBurstPid);
  inputBurstURLHost = activeFocusedURLHost(front);
  inputBurstTargetRole = activeFocusedRole();
  inputBurstTargetSubrole = activeFocusedSubrole();
}

- (void)resetInputBurst {
  inputBurstLength = 0;
  inputBurstSecure = NO;
  inputBurstAppName = @"";
  inputBurstBundleId = @"";
  inputBurstWindowTitle = @"";
  inputBurstURLHost = @"";
  inputBurstTargetRole = @"";
  inputBurstTargetSubrole = @"";
  inputBurstPid = 0;
  inputBurstWindowId = 0;
}

- (void)handleGlobalEvent:(NSEvent *)event {
  inputMonitoringObserved = YES;
  if (event.type == NSEventTypeKeyDown) {
    NSEventModifierFlags flags = event.modifierFlags;
    BOOL shortcut = (flags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagFunction)) != 0;
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    BOOL secure = activeFocusedIsSecure(front);
    if (shortcut) {
      [self flushInputBurst];
      [self emitInteraction:@"shortcut" command:@"modified_action" modifiers:modifierNames(flags) inputLength:nil secure:secure];
    } else {
      if (inputBurstLength == 0) [self beginInputBurst:front];
      if (inputBurstLength < 100000) inputBurstLength += 1;
      inputBurstSecure = inputBurstSecure || secure;
    }
    return;
  }

  if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown) {
    dragging = YES;
    dragMoved = NO;
    dragOrigin = event.locationInWindow;
    return;
  }
  if (event.type == NSEventTypeLeftMouseDragged || event.type == NSEventTypeRightMouseDragged) {
    if (dragging) {
      NSPoint point = event.locationInWindow;
      CGFloat dx = point.x - dragOrigin.x;
      CGFloat dy = point.y - dragOrigin.y;
      if ((dx * dx + dy * dy) >= 16.0) dragMoved = YES;
    }
    return;
  }
  if (event.type == NSEventTypeLeftMouseUp || event.type == NSEventTypeRightMouseUp) {
    if (!dragging) return;
    BOOL right = event.type == NSEventTypeRightMouseUp;
    NSString *kind = dragMoved ? @"drag" : (right ? @"right_click" : @"click");
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    [self emitInteraction:kind command:(dragMoved ? @"pointer_drag" : @"pointer_action") modifiers:modifierNames(event.modifierFlags) inputLength:nil secure:activeFocusedIsSecure(front)];
    dragging = NO;
    dragMoved = NO;
  }
}

- (void)flushInputBurst {
  if (inputBurstLength == 0) return;
  BOOL secure = inputBurstSecure;
  NSMutableDictionary *payload = [@{
    @"appName": secure ? @"" : (inputBurstAppName ?: @""),
    @"bundleId": secure ? @"" : (inputBurstBundleId ?: @""),
    @"windowTitle": secure ? @"" : (inputBurstWindowTitle ?: @""),
    @"occurredAtMs": @(nowMs()),
    @"type": @"input_activity",
    @"accessibility": activeAccessibilityAvailable ? @"available" : @"unavailable",
    @"command": @"typing_burst",
    @"modifiers": @[],
    @"inputLength": secure ? @0 : @(MIN(inputBurstLength, (NSUInteger)100000)),
    @"secureInput": @(secure),
    @"targetRole": secure ? @"" : (inputBurstTargetRole ?: @""),
    @"targetSubrole": secure ? @"" : (inputBurstTargetSubrole ?: @""),
    @"inputMonitoring": inputMonitoringStatus(self.globalMonitor)
  } mutableCopy];
  if (!secure && inputBurstWindowId > 0) payload[@"windowId"] = @(inputBurstWindowId);
  if (!secure && inputBurstURLHost.length) payload[@"urlHost"] = inputBurstURLHost;
  emit(payload);
  [self resetInputBurst];
}

- (void)applicationActivated:(NSNotification *)notification {
  emitApplicationEvent(notification.userInfo[NSWorkspaceApplicationKey]);
}
- (void)heartbeat:(NSTimer *)timer {
  (void)timer;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  [self flushInputBurst];
  emitWindowChangeIfNeeded(front);
  NSMutableDictionary *extra = [@{ @"inputMonitoring": inputMonitoringStatus(self.globalMonitor) } mutableCopy];
  extra[@"accessibility"] = activeAccessibilityAvailable ? @"available" : @"unavailable";
  NSString *urlHost = activeFocusedURLHost(front);
  if (urlHost.length) extra[@"urlHost"] = urlHost;
  emitActivity(@"heartbeat", front, extra);
}
@end

int main(void) {
  @autoreleasepool {
    setbuf(stdout, NULL);
    bundleBackoffUntil = [NSMutableDictionary dictionary];
    Collector *collector = [[Collector alloc] init];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:collector
      selector:@selector(applicationActivated:)
      name:NSWorkspaceDidActivateApplicationNotification object:nil];
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front) emitApplicationEvent(front);
    NSEventMask monitorMask = NSEventMaskKeyDown |
      NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged |
      NSEventMaskRightMouseDown | NSEventMaskRightMouseUp | NSEventMaskRightMouseDragged;
    collector.globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:monitorMask handler:^(NSEvent *event) {
      [collector handleGlobalEvent:event];
    }];
    collector.inputTimer = [NSTimer scheduledTimerWithTimeInterval:0.75 target:collector selector:@selector(flushInputBurst) userInfo:nil repeats:YES];
    [NSTimer scheduledTimerWithTimeInterval:2.0 target:collector selector:@selector(heartbeat:) userInfo:nil repeats:YES];
    [[NSRunLoop currentRunLoop] run];
  }
  return 0;
}
