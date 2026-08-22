import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import type { ActivityEventKind, ActivityPrivacyState } from '../shared/activity-events.ts'
import { ensureNativeHelperBinary } from './native-helper-cache.ts'

const execFileAsync = promisify(execFile)

// v3 保留给手动/兼容调用；v4 是 Hybrid History 的长驻 JSONL collector。
const COLLECTOR_OBJC_SRC = `#import <AppKit/AppKit.h>
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
  fputc('\\n', stdout);
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
`

const LEGACY_OBJC_SRC = `#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

int main(void) {
  @autoreleasepool {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front) return 0;
    pid_t pid = front.processIdentifier;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID
    ));
    NSString *title = @"";
    for (NSDictionary *window in windows) {
      NSNumber *ownerPid = window[(id)kCGWindowOwnerPID];
      NSNumber *layer = window[(id)kCGWindowLayer];
      if (ownerPid.intValue != pid || layer.intValue != 0) continue;
      id rawTitle = window[(id)kCGWindowName];
      NSString *candidate = [rawTitle isKindOfClass:NSString.class] ? rawTitle : @"";
      candidate = [candidate stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (candidate.length > 0) { title = candidate; break; }
    }
    NSDictionary *context = @{
      @"name": front.localizedName ?: @"",
      @"bundleId": front.bundleIdentifier ?: @"",
      @"windowTitle": title
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:context options:0 error:nil];
    if (json == nil) return 1;
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
`

export interface FrontmostContext {
  name: string
  bundleId: string
  windowTitle: string
  urlHost?: string
  windowId?: number
  focusedRole?: string
  focusedSubrole?: string
  safeLabel?: string
  targetRole?: string
  targetSubrole?: string
  targetId?: string
  command?: string
  modifiers?: string[]
  inputLength?: number | null
  secureInput?: boolean
  eventKind?: ActivityEventKind
  eventSource?: 'workspace' | 'accessibility' | 'collector'
}

export interface CollectorEvent {
  type:
    | 'app_activated'
    | 'heartbeat'
    | 'window_changed'
    | 'ax_focus_changed'
    | 'ax_attribute_changed'
    | 'selection_changed'
    | 'click'
    | 'right_click'
    | 'drag'
    | 'shortcut'
    | 'input_activity'
  appName: string
  bundleId: string
  windowTitle: string
  urlHost?: string
  windowId?: number
  focusedRole?: string
  focusedSubrole?: string
  safeLabel?: string
  targetRole?: string
  targetSubrole?: string
  targetId?: string
  command?: string
  modifiers?: string[]
  inputLength?: number | null
  secureInput?: boolean
  privacyState?: ActivityPrivacyState
  inputMonitoring?: 'available' | 'unavailable' | 'unknown'
  occurredAtMs: number
  accessibility: 'available' | 'unavailable'
}

export interface CollectorHealth {
  state: 'starting' | 'healthy' | 'degraded' | 'stopped'
  restartCount: number
  lastHeartbeatAtMs: number | null
  accessibility: 'available' | 'unavailable' | 'unknown'
  detail: string | null
  inputMonitoring?: 'available' | 'unavailable' | 'unknown'
}

export interface FrontmostCollectorHandle {
  stop(): void
}

function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

let ensured: Promise<string> | null = null
let collectorEnsured: Promise<string> | null = null

async function ensureBinary(): Promise<string> {
  const bin = join(binDir(), 'frontmost-context-v3-oneshot')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'frontmost-context-v3-oneshot.m')
  writeFileSync(src, LEGACY_OBJC_SRC)
  await execFileAsync('/usr/bin/xcrun', [
    'clang',
    '-fobjc-arc',
    '-O2',
    '-framework',
    'AppKit',
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    '-o',
    bin,
    src
  ])
  return bin
}

async function ensureCollectorBinary(): Promise<string> {
  return ensureNativeHelperBinary({
    directory: binDir(),
    binaryName: 'frontmost-context-v4-ax',
    source: COLLECTOR_OBJC_SRC,
    compile: async (src, bin) => {
      await execFileAsync('/usr/bin/xcrun', [
        'clang',
        '-fobjc-arc',
        '-O2',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'CoreGraphics',
        '-o',
        bin,
        src
      ])
    }
  })
}

function normalizeCollectorHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const host = value.normalize('NFKC').trim().toLowerCase()
  if (!host || host.length > 255 || /[\s/?#:@]/.test(host)) return undefined
  return host
}

function parseCollectorLine(line: string): CollectorEvent | null {
  try {
    const raw = JSON.parse(line) as Partial<CollectorEvent>
    const rawRecord = raw as Record<string, unknown>
    if (
      'text' in rawRecord ||
      'characters' in rawRecord ||
      'charactersIgnoringModifiers' in rawRecord ||
      'selectedText' in rawRecord ||
      'selected_text' in rawRecord ||
      'key' in rawRecord ||
      'keyCode' in rawRecord ||
      'value' in rawRecord ||
      'axValue' in rawRecord ||
      'url' in rawRecord ||
      'fullUrl' in rawRecord ||
      'documentURL' in rawRecord ||
      'URLString' in rawRecord ||
      'browserURL' in rawRecord
    )
      return null
    if (
      (raw.type !== 'app_activated' &&
        raw.type !== 'heartbeat' &&
        raw.type !== 'window_changed' &&
        raw.type !== 'ax_focus_changed' &&
        raw.type !== 'ax_attribute_changed' &&
        raw.type !== 'selection_changed' &&
        raw.type !== 'click' &&
        raw.type !== 'right_click' &&
        raw.type !== 'drag' &&
        raw.type !== 'shortcut' &&
        raw.type !== 'input_activity') ||
      typeof raw.appName !== 'string' ||
      typeof raw.bundleId !== 'string' ||
      typeof raw.windowTitle !== 'string' ||
      typeof raw.occurredAtMs !== 'number' ||
      !Number.isFinite(raw.occurredAtMs) ||
      (raw.accessibility !== 'available' && raw.accessibility !== 'unavailable')
    ) return null
    return {
      type: raw.type,
      appName: raw.appName.slice(0, 80),
      bundleId: raw.bundleId.slice(0, 160),
      windowTitle: raw.windowTitle.slice(0, 160),
      urlHost: normalizeCollectorHost(raw.urlHost),
      windowId:
        typeof raw.windowId === 'number' && Number.isFinite(raw.windowId)
          ? Math.max(0, Math.trunc(raw.windowId))
          : undefined,
      focusedRole: typeof raw.focusedRole === 'string' ? raw.focusedRole.slice(0, 80) : undefined,
      focusedSubrole: typeof raw.focusedSubrole === 'string' ? raw.focusedSubrole.slice(0, 80) : undefined,
      safeLabel: typeof raw.safeLabel === 'string' ? raw.safeLabel.slice(0, 160) : undefined,
      targetRole: typeof raw.targetRole === 'string' ? raw.targetRole.slice(0, 80) : undefined,
      targetSubrole: typeof raw.targetSubrole === 'string' ? raw.targetSubrole.slice(0, 80) : undefined,
      targetId: typeof raw.targetId === 'string' ? raw.targetId.slice(0, 160) : undefined,
      command: typeof raw.command === 'string' ? raw.command.slice(0, 80) : undefined,
      modifiers: Array.isArray(raw.modifiers)
        ? raw.modifiers.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 24)).slice(0, 8)
        : undefined,
      inputLength:
        typeof raw.inputLength === 'number' && Number.isFinite(raw.inputLength)
          ? Math.max(0, Math.min(100_000, Math.trunc(raw.inputLength)))
          : undefined,
      secureInput: raw.secureInput === true,
      privacyState:
        raw.privacyState === 'private' ||
        raw.privacyState === 'excluded' ||
        raw.privacyState === 'own' ||
        raw.privacyState === 'secure'
          ? raw.privacyState
          : undefined,
      inputMonitoring:
        raw.inputMonitoring === 'available' || raw.inputMonitoring === 'unavailable' || raw.inputMonitoring === 'unknown'
          ? raw.inputMonitoring
          : undefined,
      occurredAtMs: raw.occurredAtMs,
      accessibility: raw.accessibility
    }
  } catch {
    return null
  }
}

/** Long-lived JSONL collector with bounded restart attempts and heartbeat watchdog. */
export function startFrontmostCollector(
  onEvent: (event: CollectorEvent) => void,
  onHealth: (health: CollectorHealth) => void
): FrontmostCollectorHandle {
  let child: ChildProcessWithoutNullStreams | null = null
  let stopped = false
  let restartCount = 0
  let lastHeartbeatAtMs: number | null = null
  let launchStartedAtMs = Date.now()
  let accessibility: CollectorHealth['accessibility'] = 'unknown'
  let inputMonitoring: NonNullable<CollectorHealth['inputMonitoring']> = 'unknown'
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let buffer = ''

  const report = (state: CollectorHealth['state'], detail: string | null = null): void => {
    onHealth({ state, restartCount, lastHeartbeatAtMs, accessibility, detail, inputMonitoring })
  }

  const scheduleRestart = (detail: string): void => {
    if (stopped) return
    if (restartTimer) return
    child = null
    if (restartCount >= 3) {
      report('degraded', detail)
      return
    }
    const delay = 500 * 2 ** restartCount
    restartCount += 1
    report('degraded', detail)
    restartTimer = setTimeout(() => {
      restartTimer = null
      void launch()
    }, delay)
  }

  const launch = async (): Promise<void> => {
    if (stopped || child) return
    report('starting')
    try {
      if (collectorEnsured && !existsSync(await collectorEnsured.catch(() => ''))) collectorEnsured = null
      if (!collectorEnsured) collectorEnsured = ensureCollectorBinary()
      const bin = await collectorEnsured
      if (stopped) return
      const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      child = proc
      launchStartedAtMs = Date.now()
      lastHeartbeatAtMs = null
      inputMonitoring = 'unknown'
      buffer = ''
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        buffer += chunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = parseCollectorLine(line.trim())
          if (!event) continue
          if (event.type === 'heartbeat') lastHeartbeatAtMs = event.occurredAtMs
          accessibility = event.accessibility
          if (event.inputMonitoring) inputMonitoring = event.inputMonitoring
          report(event.accessibility === 'available' ? 'healthy' : 'degraded', event.accessibility === 'available' ? null : 'Accessibility unavailable')
          onEvent(event)
        }
      })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        const detail = chunk.trim().slice(0, 160)
        if (detail) report('degraded', detail)
      })
      proc.once('error', (error) => scheduleRestart(error.message))
      proc.once('exit', (code, signal) => {
        if (!stopped) scheduleRestart(`collector exited (${code ?? 'null'}/${signal ?? 'none'})`)
      })
    } catch (error) {
      scheduleRestart(error instanceof Error ? error.message : String(error))
    }
  }

  watchdogTimer = setInterval(() => {
    if (stopped || !child) return
    const now = Date.now()
    const heartbeatReference = lastHeartbeatAtMs ?? launchStartedAtMs
    if (now - heartbeatReference > 7_000) {
      child.kill()
      scheduleRestart('heartbeat timeout')
    }
  }, 3_000)
  void launch()

  return {
    stop(): void {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      if (child) child.kill()
      child = null
      report('stopped')
    }
  }
}

/** Current foreground app context; manual and legacy paths keep this fail-closed helper. */
export async function getFrontmostContext(): Promise<FrontmostContext | null> {
  try {
    if (ensured && !existsSync(await ensured.catch(() => ''))) ensured = null
    if (!ensured)
      ensured = ensureBinary().catch((e) => {
        ensured = null
        throw e
      })
    const bin = await ensured
    const { stdout } = await execFileAsync(bin, [], { timeout: 3000 })
    const raw = stdout.trim()
    if (!raw) return null
    const context = JSON.parse(raw) as Partial<FrontmostContext>
    if (
      typeof context.name !== 'string' ||
      typeof context.bundleId !== 'string' ||
      typeof context.windowTitle !== 'string'
    ) return null
    return { name: context.name, bundleId: context.bundleId, windowTitle: context.windowTitle }
  } catch {
    return null
  }
}

/** 当前前台 App 的本地化名称；兼容现有排除和切换检测调用方。 */
export async function getFrontmostApp(): Promise<string | null> {
  const context = await getFrontmostContext()
  return context?.name || null
}
