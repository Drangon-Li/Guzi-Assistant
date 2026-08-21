import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

// v3 保留给手动/兼容调用；v4 是 Hybrid History 的长驻 JSONL collector。
const COLLECTOR_OBJC_SRC = `#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

static AXObserverRef activeObserver = NULL;
static AXUIElementRef activeApplication = NULL;
static pid_t activePid = 0;

static NSString *trimmed(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return @"";
  return [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static NSString *attributeString(AXUIElementRef element, CFStringRef attribute) {
  if (!element) return @"";
  CFTypeRef raw = NULL;
  AXError result = AXUIElementCopyAttributeValue(element, attribute, &raw);
  if (result != kAXErrorSuccess || !raw) return @"";
  NSString *value = CFGetTypeID(raw) == CFStringGetTypeID() ? [(__bridge NSString *)raw copy] : @"";
  CFRelease(raw);
  return trimmed(value);
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
    @"occurredAtMs": @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0))
  };
}

static void clearAccessibilityObserver(void) {
  if (activeObserver && activeApplication) {
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXFocusedWindowChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXFocusedUIElementChangedNotification);
    AXObserverRemoveNotification(activeObserver, activeApplication, kAXTitleChangedNotification);
    CFRunLoopSourceRef source = AXObserverGetRunLoopSource(activeObserver);
    if (source) CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
  }
  if (activeObserver) CFRelease(activeObserver);
  if (activeApplication) CFRelease(activeApplication);
  activeObserver = NULL;
  activeApplication = NULL;
  activePid = 0;
}

static void emitFocusedMetadata(NSString *type, NSRunningApplication *application) {
  if (!activeApplication || !application) return;
  AXUIElementRef focused = NULL;
  AXUIElementCopyAttributeValue(activeApplication, kAXFocusedUIElementAttribute, (CFTypeRef *)&focused);
  NSString *role = attributeString(focused, kAXRoleAttribute);
  NSString *title = attributeString(focused, kAXTitleAttribute);
  if (!title.length) title = attributeString(focused, kAXDescriptionAttribute);
  NSMutableDictionary *payload = [baseContext(application) mutableCopy];
  payload[@"type"] = type;
  payload[@"focusedRole"] = role;
  payload[@"safeLabel"] = title.length > 160 ? [title substringToIndex:160] : title;
  payload[@"accessibility"] = @"available";
  emit(payload);
  if (focused) CFRelease(focused);
}

static void accessibilityCallback(AXObserverRef observer, AXUIElementRef element, CFStringRef notification, void *refcon) {
  (void)observer; (void)element; (void)refcon;
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:activePid];
  if (!application) return;
  NSString *name = (__bridge NSString *)notification;
  NSString *type = [name isEqualToString:(__bridge NSString *)kAXFocusedUIElementChangedNotification]
    ? @"ax_focus_changed" : @"ax_attribute_changed";
  emitFocusedMetadata(type, application);
}

static BOOL attachAccessibility(NSRunningApplication *application) {
  clearAccessibilityObserver();
  if (!application || !AXIsProcessTrusted()) return NO;
  pid_t pid = application.processIdentifier;
  AXUIElementRef appElement = AXUIElementCreateApplication(pid);
  if (!appElement) return NO;
  AXObserverRef observer = NULL;
  if (AXObserverCreate(pid, accessibilityCallback, &observer) != kAXErrorSuccess || !observer) {
    CFRelease(appElement);
    return NO;
  }
  CFStringRef notifications[] = {
    kAXFocusedWindowChangedNotification,
    kAXFocusedUIElementChangedNotification,
    kAXTitleChangedNotification
  };
  for (NSUInteger i = 0; i < sizeof(notifications) / sizeof(notifications[0]); i++)
    AXObserverAddNotification(observer, appElement, notifications[i], NULL);
  CFRunLoopSourceRef source = AXObserverGetRunLoopSource(observer);
  if (source) CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopDefaultMode);
  activeObserver = observer;
  activeApplication = appElement;
  activePid = pid;
  return YES;
}

static void emitApplicationEvent(NSRunningApplication *application) {
  if (!application) return;
  BOOL accessibility = attachAccessibility(application);
  NSMutableDictionary *payload = [baseContext(application) mutableCopy];
  payload[@"type"] = @"app_activated";
  payload[@"accessibility"] = accessibility ? @"available" : @"unavailable";
  emit(payload);
  if (accessibility) emitFocusedMetadata(@"ax_focus_changed", application);
}

@interface Collector : NSObject
@end
@implementation Collector
- (void)applicationActivated:(NSNotification *)notification {
  emitApplicationEvent(notification.userInfo[NSWorkspaceApplicationKey]);
}
- (void)heartbeat:(NSTimer *)timer {
  (void)timer;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  NSMutableDictionary *payload = [baseContext(front) mutableCopy];
  payload[@"type"] = @"heartbeat";
  payload[@"accessibility"] = activeObserver ? @"available" : @"unavailable";
  emit(payload);
}
@end

int main(void) {
  @autoreleasepool {
    setbuf(stdout, NULL);
    Collector *collector = [[Collector alloc] init];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:collector
      selector:@selector(applicationActivated:)
      name:NSWorkspaceDidActivateApplicationNotification object:nil];
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front) emitApplicationEvent(front);
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
  focusedRole?: string
  safeLabel?: string
  eventKind?: 'app_activated' | 'window_changed' | 'ax_focus_changed' | 'ax_attribute_changed'
  eventSource?: 'workspace' | 'accessibility' | 'collector'
}

export interface CollectorEvent {
  type: 'app_activated' | 'heartbeat' | 'ax_focus_changed' | 'ax_attribute_changed'
  appName: string
  bundleId: string
  windowTitle: string
  focusedRole?: string
  safeLabel?: string
  occurredAtMs: number
  accessibility: 'available' | 'unavailable'
}

export interface CollectorHealth {
  state: 'starting' | 'healthy' | 'degraded' | 'stopped'
  restartCount: number
  lastHeartbeatAtMs: number | null
  accessibility: 'available' | 'unavailable' | 'unknown'
  detail: string | null
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
  const bin = join(binDir(), 'frontmost-context-v4-ax')
  if (existsSync(bin)) return bin
  mkdirSync(binDir(), { recursive: true })
  const src = join(binDir(), 'frontmost-context-v4-ax.m')
  writeFileSync(src, COLLECTOR_OBJC_SRC)
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

function parseCollectorLine(line: string): CollectorEvent | null {
  try {
    const raw = JSON.parse(line) as Partial<CollectorEvent>
    if (
      (raw.type !== 'app_activated' && raw.type !== 'heartbeat' && raw.type !== 'ax_focus_changed' && raw.type !== 'ax_attribute_changed') ||
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
      focusedRole: typeof raw.focusedRole === 'string' ? raw.focusedRole.slice(0, 80) : undefined,
      safeLabel: typeof raw.safeLabel === 'string' ? raw.safeLabel.slice(0, 160) : undefined,
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
  let accessibility: CollectorHealth['accessibility'] = 'unknown'
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let buffer = ''

  const report = (state: CollectorHealth['state'], detail: string | null = null): void => {
    onHealth({ state, restartCount, lastHeartbeatAtMs, accessibility, detail })
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
          report('healthy')
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
    if (lastHeartbeatAtMs != null && now - lastHeartbeatAtMs > 7_000) {
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
