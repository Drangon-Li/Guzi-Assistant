#import <AppKit/AppKit.h>
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
