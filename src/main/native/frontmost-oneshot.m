#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>

static id axAttributeChecked(AXUIElementRef element, CFStringRef key, AXError *status) {
  if (!element) { if (status) *status = kAXErrorInvalidUIElement; return nil; }
  CFTypeRef value = NULL;
  AXError result = AXUIElementCopyAttributeValue(element, key, &value);
  if (status) *status = result;
  if (result != kAXErrorSuccess) { if (value) CFRelease(value); return nil; }
  return CFBridgingRelease(value);
}

static id axAttribute(AXUIElementRef element, CFStringRef key) {
  return axAttributeChecked(element, key, NULL);
}

int main(void) {
  @autoreleasepool {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front) return 0;
    pid_t pid = front.processIdentifier;
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(application, 0.6);
    id focusedWindow = axAttribute(application, kAXFocusedWindowAttribute);
    id focus = axAttribute(application, kAXFocusedUIElementAttribute);
    AXError roleResult = kAXErrorNoValue;
    AXError subroleResult = kAXErrorNoValue;
    id rawRole = axAttributeChecked((__bridge AXUIElementRef)focus, kAXRoleAttribute, &roleResult);
    id rawSubrole = axAttributeChecked((__bridge AXUIElementRef)focus, kAXSubroleAttribute, &subroleResult);
    NSString *role = [rawRole isKindOfClass:NSString.class] ? rawRole : nil;
    NSString *subrole = [rawSubrole isKindOfClass:NSString.class] ? rawSubrole : nil;
    BOOL available = AXIsProcessTrusted() && focusedWindow && role.length > 0 && roleResult == kAXErrorSuccess &&
      (subroleResult == kAXErrorSuccess || subroleResult == kAXErrorNoValue);
    BOOL secure = IsSecureEventInputEnabled() || (role && [role rangeOfString:@"secure" options:NSCaseInsensitiveSearch].location != NSNotFound) ||
      (subrole && [subrole rangeOfString:@"secure" options:NSCaseInsensitiveSearch].location != NSNotFound);
    NSString *title = @"";
    CGPoint position = CGPointZero;
    CGSize size = CGSizeZero;
    BOOL hasBounds = NO;
    if (focusedWindow) {
      AXUIElementRef window = (__bridge AXUIElementRef)focusedWindow;
      id rawTitle = axAttribute(window, kAXTitleAttribute);
      title = [rawTitle isKindOfClass:NSString.class] ? rawTitle : @"";
      id point = axAttribute(window, kAXPositionAttribute);
      id dimensions = axAttribute(window, kAXSizeAttribute);
      if (point && dimensions && CFGetTypeID((__bridge CFTypeRef)point) == AXValueGetTypeID() &&
          CFGetTypeID((__bridge CFTypeRef)dimensions) == AXValueGetTypeID()) {
        hasBounds = AXValueGetValue((__bridge AXValueRef)point, kAXValueCGPointType, &position) &&
          AXValueGetValue((__bridge AXValueRef)dimensions, kAXValueCGSizeType, &size);
      }
    }
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSNumber *windowId = nil;
    NSUInteger matches = 0;
    for (NSDictionary *window in windows) {
      NSNumber *ownerPid = window[(id)kCGWindowOwnerPID];
      NSNumber *layer = window[(id)kCGWindowLayer];
      if (ownerPid.intValue != pid || layer.intValue != 0) continue;
      CGRect bounds;
      if (!hasBounds || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
      if (fabs(bounds.origin.x - position.x) > 2 || fabs(bounds.origin.y - position.y) > 2 ||
          fabs(bounds.size.width - size.width) > 2 || fabs(bounds.size.height - size.height) > 2) continue;
      id rawTitle = window[(id)kCGWindowName];
      if ([rawTitle isKindOfClass:NSString.class] && [rawTitle length] && ![rawTitle isEqualToString:title]) continue;
      matches++;
      windowId = window[(id)kCGWindowNumber];
    }
    NSDictionary *context = @{
      @"observedAtMs": @((long long)(NSDate.date.timeIntervalSince1970 * 1000)),
      @"pid": @(pid), @"windowId": matches == 1 && windowId ? windowId : NSNull.null,
      @"name": front.localizedName ?: @"", @"bundleId": front.bundleIdentifier ?: @"",
      @"windowTitle": title, @"accessibility": available ? @"available" : @"unavailable",
      @"focusedRole": role ?: NSNull.null, @"focusedSubrole": subrole ?: NSNull.null,
      @"secureInput": secure ? @YES : (available ? @NO : NSNull.null)
    };
    CFRelease(application);
    NSData *json = [NSJSONSerialization dataWithJSONObject:context options:0 error:nil];
    if (!json) return 1;
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
