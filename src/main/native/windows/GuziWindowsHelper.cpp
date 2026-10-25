#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <winver.h>
#include <wincodec.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <vector>
#include "protocol.h"

using Microsoft::WRL::ComPtr;
namespace {
HANDLE stopEvent = nullptr;
HHOOK keyboardHook = nullptr;
HHOOK mouseHook = nullptr;
HWINEVENTHOOK focusHook = nullptr;
HWINEVENTHOOK selectionHook = nullptr;
HWINEVENTHOOK textSelectionHook = nullptr;
std::atomic<bool> focusChanged{false};
std::wstring parentImage;
uint64_t lastInputAt = 0;
bool inputObserved = false;

uint64_t nowMs() {
  FILETIME ft{};
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER value{};
  value.LowPart = ft.dwLowDateTime;
  value.HighPart = ft.dwHighDateTime;
  return (value.QuadPart - 116444736000000000ULL) / 10000;
}

std::string utf8(const std::wstring& value) {
  if (value.empty()) return "";
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (!size) return "";
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

std::string jsonWideString(const std::wstring& value) { return guzi::jsonString(utf8(value)); }
void emit(const std::string& value) {
  if (fwrite(value.data(), 1, value.size(), stdout) != value.size() || fputc('\n', stdout) == EOF || fflush(stdout) != 0) {
    if (stopEvent) SetEvent(stopEvent);
  }
}

std::wstring canonicalPath(const std::wstring& path) {
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return L"";
  std::vector<wchar_t> buffer(32768);
  DWORD count = GetFinalPathNameByHandleW(file, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(file);
  return count && count < buffer.size() ? guzi::normalizePath(std::wstring(buffer.data(), count)) : L"";
}

std::wstring processImage(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return L"";
  std::vector<wchar_t> buffer(32768);
  DWORD count = static_cast<DWORD>(buffer.size());
  const bool success = QueryFullProcessImageNameW(process, 0, buffer.data(), &count) != FALSE;
  CloseHandle(process);
  return success ? canonicalPath(std::wstring(buffer.data(), count)) : L"";
}

std::wstring appName(const std::wstring& path) {
  const auto exe = guzi::executableName(path);
  if (exe == L"chrome.exe") return L"Google Chrome";
  if (exe == L"msedge.exe") return L"Microsoft Edge";
  if (exe == L"firefox.exe") return L"Firefox";
  if (exe == L"brave.exe") return L"Brave";
  if (exe == L"explorer.exe") return L"File Explorer";
  if (exe == L"guzi-assistant.exe" || exe == L"谷子助手.exe") return L"谷子助手";
  DWORD ignored = 0;
  DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
  if (size && size <= 1024 * 1024) {
    std::vector<BYTE> info(size);
    if (GetFileVersionInfoW(path.c_str(), 0, size, info.data())) {
      struct Translation { WORD language; WORD codepage; };
      Translation* translations = nullptr;
      UINT bytes = 0;
      if (VerQueryValueW(info.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &bytes) && bytes >= sizeof(Translation)) {
        wchar_t key[80]{};
        swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", translations[0].language, translations[0].codepage);
        wchar_t* name = nullptr;
        UINT chars = 0;
        if (VerQueryValueW(info.data(), key, reinterpret_cast<void**>(&name), &chars) && chars > 1 && chars < 256)
          return std::wstring(name, chars - 1);
      }
    }
  }
  return exe.size() > 4 ? exe.substr(0, exe.size() - 4) : exe;
}

std::wstring propertyString(IUIAutomationElement* element, PROPERTYID property) {
  VARIANT value{};
  if (FAILED(element->GetCurrentPropertyValue(property, &value))) return L"";
  std::wstring result;
  if (value.vt == VT_BSTR && value.bstrVal) result.assign(value.bstrVal, std::min<UINT>(SysStringLen(value.bstrVal), 4096));
  VariantClear(&value);
  return result;
}

std::wstring runtimeIdentity(IUIAutomationElement* element) {
  SAFEARRAY* id = nullptr;
  if (FAILED(element->GetRuntimeId(&id)) || !id) return L"";
  LONG first = 0, last = -1;
  std::wstring material;
  if (SUCCEEDED(SafeArrayGetLBound(id, 1, &first)) && SUCCEEDED(SafeArrayGetUBound(id, 1, &last)) && last - first < 64) {
    for (LONG i = first; i <= last; ++i) {
      int part = 0;
      if (FAILED(SafeArrayGetElement(id, &i, &part))) { material.clear(); break; }
      material += std::to_wstring(part) + L":";
    }
  }
  SafeArrayDestroy(id);
  if (material.empty()) return L"";
  const auto digest = guzi::hash(material);
  return std::wstring(digest.begin(), digest.end());
}

ComPtr<IUIAutomation> automation() {
  ComPtr<IUIAutomation> result;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&result)))) return nullptr;
  ComPtr<IUIAutomation2> bounded;
  if (FAILED(result.As(&bounded)) || FAILED(bounded->put_ConnectionTimeout(200)) || FAILED(bounded->put_TransactionTimeout(250))) return nullptr;
  return result;
}

HWND nativeAncestor(IUIAutomation* uia, IUIAutomationElement* element) {
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(uia->get_RawViewWalker(&walker))) return nullptr;
  ComPtr<IUIAutomationElement> current = element;
  for (int depth = 0; current && depth < 32; ++depth) {
    UIA_HWND native = nullptr;
    if (SUCCEEDED(current->get_CurrentNativeWindowHandle(&native)) && native)
      return GetAncestor(static_cast<HWND>(native), GA_ROOT);
    ComPtr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElement(current.Get(), &parent))) return nullptr;
    current = parent;
  }
  return nullptr;
}

struct BrowserState {
  bool privateWindow = false;
  bool normalWindow = false;
  bool complete = true;
  std::wstring host;
};

bool normalProfileMarker(const std::wstring& name, const std::wstring& className, const std::wstring& id, int culture) {
  if (guzi::privateMarker(name)) return false;
  const auto lowered = guzi::lower(name);
  const bool profileControl = className == L"AvatarToolbarButton" || className == L"ProfileButton" ||
    id == L"profile-button" || id == L"avatar-button" || id == L"profileButton";
  const auto language = PRIMARYLANGID(culture);
  if (profileControl && !name.empty() && (language == LANG_ENGLISH || language == LANG_CHINESE)) return true;
  static const std::wregex normal(L"^(profile: .+|your profile.*|profiles?|profile [0-9]+|person [0-9]+|you|personal|work|个人资料.*|個人資料.*|个人|工作|用户 [0-9]+|使用者 [0-9]+)$", std::regex::icase);
  return std::regex_match(lowered, normal);
}

BrowserState inspectBrowser(IUIAutomation* uia, HWND window, const std::wstring& title) {
  BrowserState state;
  if (guzi::privateMarker(title)) { state.privateWindow = true; return state; }
  ComPtr<IUIAutomationElement> root;
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(uia->ElementFromHandle(window, &root)) || FAILED(uia->get_ControlViewWalker(&walker))) { state.complete = false; return state; }
  const ULONGLONG deadline = GetTickCount64() + 600;
  unsigned nodes = 0;
  std::function<void(IUIAutomationElement*, int, bool)> walk;
  walk = [&](IUIAutomationElement* element, int depth, bool toolbar) {
    if (!state.complete || state.privateWindow) return;
    if (++nodes > 350 || depth > 10 || GetTickCount64() > deadline) { state.complete = false; return; }
    CONTROLTYPEID type = 0;
    BOOL offscreen = FALSE;
    if (FAILED(element->get_CurrentControlType(&type)) || FAILED(element->get_CurrentIsOffscreen(&offscreen))) { state.complete = false; return; }
    // Web content never participates in browser-mode or address-bar detection.
    if (offscreen || type == UIA_DocumentControlTypeId || type == UIA_ListControlTypeId || type == UIA_MenuControlTypeId) return;
    const auto className = propertyString(element, UIA_ClassNamePropertyId);
    const auto id = propertyString(element, UIA_AutomationIdPropertyId);
    if (type == UIA_ToolBarControlTypeId) {
      const auto label = guzi::lower(propertyString(element, UIA_NamePropertyId));
      if (label.find(L"bookmark") != std::wstring::npos || label.find(L"favorite") != std::wstring::npos || label.find(L"书签") != std::wstring::npos || label.find(L"收藏") != std::wstring::npos) return;
      toolbar = true;
    }
    if (toolbar && (type == UIA_ButtonControlTypeId || type == UIA_SplitButtonControlTypeId || type == UIA_MenuItemControlTypeId)) {
      const auto name = propertyString(element, UIA_NamePropertyId);
      const auto help = propertyString(element, UIA_HelpTextPropertyId);
      int culture = 0;
      element->get_CurrentCulture(&culture);
      if (guzi::privateMarker(name + L" " + help)) state.privateWindow = true;
      if (normalProfileMarker(name, className, id, culture) || normalProfileMarker(help, className, id, culture)) state.normalWindow = true;
    }
    if (type == UIA_EditControlTypeId) {
      const auto name = guzi::lower(propertyString(element, UIA_NamePropertyId));
      const bool address = toolbar && (id == L"addressEditBox" || id == L"urlbar-input" ||
        name == L"address and search bar" || name == L"search or enter web address" || name == L"search with google or enter address" ||
        name == L"地址和搜索栏" || name == L"地址與搜尋列" || name == L"搜索或输入网址" || name == L"搜尋或輸入網址");
      BOOL password = TRUE;
      if (address && SUCCEEDED(element->get_CurrentIsPassword(&password)) && !password) {
        ComPtr<IUIAutomationValuePattern> value;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value)))) {
          BSTR raw = nullptr;
          if (SUCCEEDED(value->get_CurrentValue(&raw)) && raw) {
            state.host = guzi::hostOnly(std::wstring(raw, SysStringLen(raw)));
            SecureZeroMemory(raw, SysStringByteLen(raw));
            SysFreeString(raw);
          }
        }
      }
      return;
    }
    ComPtr<IUIAutomationElement> child;
    if (FAILED(walker->GetFirstChildElement(element, &child))) { state.complete = false; return; }
    while (child && state.complete && !state.privateWindow) {
      walk(child.Get(), depth + 1, toolbar);
      ComPtr<IUIAutomationElement> sibling;
      if (FAILED(walker->GetNextSiblingElement(child.Get(), &sibling))) { state.complete = false; return; }
      child = sibling;
    }
  };
  walk(root.Get(), 0, false);
  if (!state.complete) state.normalWindow = false;
  return state;
}

struct Snapshot {
  uint64_t observed = nowMs();
  HWND window = nullptr;
  DWORD pid = 0;
  std::wstring image, name, bundle, title, role, focusId, host;
  std::string privacy = "excluded";
  std::string detail = "Windows foreground safety unavailable";
  bool accessible = false;
  bool secure = true;
  bool secureKnown = false;
};

Snapshot snapshot(IUIAutomation* uia) {
  Snapshot out;
  out.window = GetForegroundWindow();
  if (!out.window || !IsWindowVisible(out.window) || GetAncestor(out.window, GA_ROOT) != out.window) return out;
  GetWindowThreadProcessId(out.window, &out.pid);
  out.image = processImage(out.pid);
  if (out.image.empty()) return out;
  out.bundle = guzi::identity(out.image);
  out.name = appName(out.image);
  if (!parentImage.empty() && parentImage == out.image) { out.privacy = "own"; out.detail = "Own application suppressed"; return out; }
  if (!uia) return out;
  std::vector<wchar_t> title(2048);
  const int titleLength = GetWindowTextW(out.window, title.data(), static_cast<int>(title.size()));
  const std::wstring rawTitle(title.data(), std::max(0, titleLength));
  ComPtr<IUIAutomationElement> focus;
  CONTROLTYPEID role = 0;
  BOOL password = TRUE;
  if (FAILED(uia->GetFocusedElement(&focus)) || !focus || nativeAncestor(uia, focus.Get()) != out.window ||
      FAILED(focus->get_CurrentControlType(&role)) || FAILED(focus->get_CurrentIsPassword(&password))) return out;
  out.focusId = runtimeIdentity(focus.Get());
  if (out.focusId.empty()) return out;
  out.secureKnown = true;
  out.secure = password != FALSE;
  out.role = password ? L"UIAPassword" : L"UIA" + std::to_wstring(role);
  if (out.secure) { out.privacy = "secure"; out.detail = "Secure input suppressed"; return out; }
  if (guzi::browser(guzi::executableName(out.image))) {
    const auto mode = inspectBrowser(uia, out.window, rawTitle);
    if (mode.privateWindow) { out.privacy = "private"; out.secure = true; out.detail = "Private browser window suppressed"; return out; }
    if (!mode.complete || !mode.normalWindow) { out.secureKnown = false; out.detail = "Browser privacy mode unavailable"; return out; }
    out.host = mode.host;
  }
  ComPtr<IUIAutomationElement> finalFocus;
  DWORD finalPid = 0;
  GetWindowThreadProcessId(out.window, &finalPid);
  if (GetForegroundWindow() != out.window || finalPid != out.pid || FAILED(uia->GetFocusedElement(&finalFocus)) || !finalFocus ||
      out.focusId != runtimeIdentity(finalFocus.Get())) { out.secureKnown = false; out.host.clear(); return out; }
  out.accessible = true;
  out.privacy = "normal";
  out.detail.clear();
  out.title = guzi::safeTitle(rawTitle);
  out.observed = nowMs();
  return out;
}

std::string snapshotJson(const Snapshot& s) {
  return "{\"observedAtMs\":" + std::to_string(s.observed) + ",\"pid\":" + std::to_string(s.pid) +
    ",\"windowId\":" + std::to_string(reinterpret_cast<uintptr_t>(s.window)) + ",\"name\":" + jsonWideString(s.name) +
    ",\"bundleId\":" + jsonWideString(s.bundle) + ",\"windowTitle\":" + jsonWideString(s.title) +
    ",\"accessibility\":" + guzi::jsonString(s.accessible ? "available" : "unavailable") +
    ",\"focusedRole\":" + (s.role.empty() ? "null" : jsonWideString(s.role)) +
    ",\"focusedSubrole\":" + (s.focusId.empty() ? "null" : jsonWideString(L"UIA:" + s.focusId)) +
    ",\"secureInput\":" + (s.secureKnown ? (s.secure ? "true" : "false") : "null") + "}";
}

bool sameFocus(const Snapshot& left, const Snapshot& right) {
  return left.window == right.window && left.pid == right.pid && left.image == right.image && left.focusId == right.focusId &&
    left.privacy == right.privacy && left.title == right.title;
}

int captureWindow(IUIAutomation* uia, const std::wstring& handle, const std::wstring& path) {
  if (handle.empty() || handle.find_first_not_of(L"0123456789") != std::wstring::npos) return 2;
  wchar_t* end = nullptr;
  const auto id = _wcstoui64(handle.c_str(), &end, 10);
  if (!id || !end || *end || id > 0x1fffffffffffffULL || path.size() < 4) return 2;
  const HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(id));
  const auto before = snapshot(uia);
  if (before.window != window || !before.accessible || before.privacy != "normal" || IsIconic(window)) return 3;
  RECT rect{};
  if (!GetWindowRect(window, &rect)) return 3;
  const LONG width = rect.right - rect.left, height = rect.bottom - rect.top;
  if (width < 16 || height < 16 || width > 16384 || height > 16384 || static_cast<uint64_t>(width) * height > 64000000) return 3;
  HDC screen = GetDC(window);
  if (!screen) return 3;
  HDC memory = CreateCompatibleDC(screen);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* rawPixels = nullptr;
  HBITMAP bitmap = memory ? CreateDIBSection(screen, &info, DIB_RGB_COLORS, &rawPixels, nullptr, 0) : nullptr;
  ReleaseDC(window, screen);
  if (!bitmap || !rawPixels) { if (memory) DeleteDC(memory); return 3; }
  const HGDIOBJ previous = SelectObject(memory, bitmap);
  const size_t pixels = static_cast<size_t>(width) * height;
  SecureZeroMemory(rawPixels, pixels * 4);
  // PrintWindow asks only this HWND to render. Desktop BitBlt is never a fallback.
  const BOOL rendered = PrintWindow(window, memory, PW_RENDERFULLCONTENT);
  SelectObject(memory, previous);
  DeleteDC(memory);
  const auto after = snapshot(uia);
  int result = 3;
  if (rendered && after.accessible && after.privacy == "normal" && sameFocus(before, after)) {
    auto* bytes = static_cast<BYTE*>(rawPixels);
    BYTE minimum = 255, maximum = 0;
    size_t visible = 0;
    const size_t stride = std::max<size_t>(1, pixels / 100000);
    for (size_t i = 0; i < pixels; i += stride) {
      const unsigned intensity = static_cast<unsigned>(bytes[i * 4]) + bytes[i * 4 + 1] + bytes[i * 4 + 2];
      const auto mean = static_cast<BYTE>(intensity / 3);
      minimum = std::min(minimum, mean);
      maximum = std::max(maximum, mean);
      if (intensity > 12) ++visible;
    }
    if (maximum - minimum > 4 && visible > 16) {
      for (size_t i = 0; i < pixels; ++i) bytes[i * 4 + 3] = 255;
      ComPtr<IWICImagingFactory> factory;
      ComPtr<IStream> stream;
      ComPtr<IWICBitmapEncoder> encoder;
      ComPtr<IWICBitmapFrameEncode> frame;
      WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
      HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
      if (SUCCEEDED(hr)) hr = CreateStreamOnHGlobal(nullptr, TRUE, &stream);
      if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
      if (SUCCEEDED(hr)) hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
      if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(&frame, nullptr);
      if (SUCCEEDED(hr)) hr = frame->Initialize(nullptr);
      if (SUCCEEDED(hr)) hr = frame->SetSize(width, height);
      if (SUCCEEDED(hr)) hr = frame->SetPixelFormat(&format);
      if (SUCCEEDED(hr) && !IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) hr = E_FAIL;
      if (SUCCEEDED(hr)) hr = frame->WritePixels(height, width * 4, static_cast<UINT>(pixels * 4), bytes);
      if (SUCCEEDED(hr)) hr = frame->Commit();
      if (SUCCEEDED(hr)) hr = encoder->Commit();
      STATSTG stat{};
      HGLOBAL encoded = nullptr;
      if (SUCCEEDED(hr)) hr = stream->Stat(&stat, STATFLAG_NONAME);
      if (SUCCEEDED(hr)) hr = GetHGlobalFromStream(stream.Get(), &encoded);
      const auto finalState = snapshot(uia);
      if (SUCCEEDED(hr) && finalState.accessible && finalState.privacy == "normal" && sameFocus(before, finalState) && stat.cbSize.QuadPart > 0 && stat.cbSize.QuadPart < 256 * 1024 * 1024) {
        const void* png = GlobalLock(encoded);
        if (png) {
          HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
          if (file != INVALID_HANDLE_VALUE) {
            DWORD written = 0;
            const bool saved = WriteFile(file, png, static_cast<DWORD>(stat.cbSize.QuadPart), &written, nullptr) && written == stat.cbSize.QuadPart;
            CloseHandle(file);
            if (saved) { emit("{\"path\":" + jsonWideString(path) + "}"); result = 0; }
            else DeleteFileW(path.c_str());
          }
          GlobalUnlock(encoded);
        }
      }
    }
  }
  SecureZeroMemory(rawPixels, pixels * 4);
  DeleteObject(bitmap);
  return result;
}

struct Input {
  std::string category, command;
  uint64_t at = 0;
  HWND window = nullptr;
  HWND focus = nullptr;
  unsigned count = 0;
};
std::mutex inputMutex;
std::deque<Input> inputs;
POINT mouseDown{};
bool leftDown = false;

void queueInput(std::string category, std::string command = "", unsigned count = 0) {
  Input event;
  event.category = std::move(category);
  event.command = std::move(command);
  event.count = count;
  event.at = nowMs();
  event.window = GetForegroundWindow();
  DWORD thread = GetWindowThreadProcessId(event.window, nullptr);
  GUITHREADINFO info{sizeof(info)};
  if (!thread || !GetGUIThreadInfo(thread, &info)) return;
  event.focus = info.hwndFocus;
  std::lock_guard<std::mutex> guard(inputMutex);
  if (inputs.size() < 256) inputs.push_back(std::move(event));
}

LRESULT CALLBACK keyboard(int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)) {
    const auto* event = reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
    if (!(event->flags & LLKHF_INJECTED)) {
      const DWORD key = event->vkCode;
      const bool modifier = key == VK_SHIFT || key == VK_LSHIFT || key == VK_RSHIFT || key == VK_CONTROL || key == VK_LCONTROL ||
        key == VK_RCONTROL || key == VK_MENU || key == VK_LMENU || key == VK_RMENU || key == VK_LWIN || key == VK_RWIN;
      if (!modifier) {
        const bool control = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        const bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
        const bool win = ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) != 0;
        if (control || alt || win) {
          std::string command = "shortcut";
          if (control && !alt && !win) {
            if (key == 'C') command = "copy";
            else if (key == 'V') command = "paste";
            else if (key == 'X') command = "cut";
            else if (key == 'Z') command = "undo";
            else if (key == 'S') command = "save";
          }
          queueInput("shortcut", command);
        } else if (key != VK_TAB && key != VK_ESCAPE && key != VK_CAPITAL && key != VK_NUMLOCK && key != VK_SCROLL &&
                   !(key >= VK_F1 && key <= VK_F24) && !(key >= VK_PRIOR && key <= VK_DOWN)) {
          queueInput("input_activity", "typing_burst", 1);
        }
      }
    }
  }
  return CallNextHookEx(nullptr, code, message, data);
}

LRESULT CALLBACK mouse(int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION) {
    const auto* event = reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    if (!(event->flags & LLMHF_INJECTED)) {
      if (message == WM_LBUTTONDOWN) { mouseDown = event->pt; leftDown = true; }
      else if (message == WM_LBUTTONUP) {
        const bool dragged = leftDown && (abs(event->pt.x - mouseDown.x) > GetSystemMetrics(SM_CXDRAG) || abs(event->pt.y - mouseDown.y) > GetSystemMetrics(SM_CYDRAG));
        queueInput(dragged ? "drag" : "click");
        leftDown = false;
      } else if (message == WM_RBUTTONUP) queueInput("right_click");
    }
  }
  return CallNextHookEx(nullptr, code, message, data);
}

void CALLBACK focusEvent(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD) { focusChanged = true; }
void CALLBACK selectionEvent(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
  if (window && GetAncestor(window, GA_ROOT) == GetForegroundWindow()) queueInput("selection_changed");
}

void emitCollector(const std::string& type, const Snapshot& s, const std::string& command = "", unsigned count = 0) {
  const bool listener = keyboardHook && mouseHook;
  std::string value = "{\"type\":" + guzi::jsonString(type) + ",\"appName\":" + jsonWideString(s.name) + ",\"bundleId\":" + jsonWideString(s.bundle) +
    ",\"windowTitle\":" + jsonWideString(s.title) + ",\"windowId\":" + std::to_string(reinterpret_cast<uintptr_t>(s.window)) +
    ",\"occurredAtMs\":" + std::to_string(nowMs()) + ",\"accessibility\":" + guzi::jsonString(s.accessible ? "available" : "unavailable") +
    ",\"privacyState\":" + guzi::jsonString(s.privacy) + ",\"secureInput\":" + (s.secure ? "true" : "false") +
    ",\"inputMonitoring\":" + guzi::jsonString(!listener ? "unavailable" : inputObserved ? "available" : "unknown") +
    ",\"inputMonitoringPermission\":" + guzi::jsonString(listener ? "available" : "unavailable") +
    ",\"inputMonitoringListener\":" + guzi::jsonString(listener ? "active" : "inactive") +
    ",\"lastInputEventAtMs\":" + (lastInputAt ? std::to_string(lastInputAt) : "null");
  if (!s.role.empty()) value += ",\"focusedRole\":" + jsonWideString(s.role);
  if (!s.focusId.empty()) value += ",\"focusedSubrole\":" + jsonWideString(L"UIA:" + s.focusId);
  if (!s.host.empty()) value += ",\"urlHost\":" + jsonWideString(s.host);
  if (!command.empty()) value += ",\"command\":" + guzi::jsonString(command);
  if (!s.detail.empty()) value += ",\"detail\":" + guzi::jsonString(s.detail);
  if (count) value += ",\"inputLength\":" + std::to_string(count);
  emit(value + "}");
}

int collect(IUIAutomation* uia) {
  keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, GetModuleHandleW(nullptr), 0);
  mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouse, GetModuleHandleW(nullptr), 0);
  focusHook = SetWinEventHook(EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS, nullptr, focusEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  selectionHook = SetWinEventHook(EVENT_OBJECT_SELECTION, EVENT_OBJECT_SELECTIONWITHIN, nullptr, selectionEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  textSelectionHook = SetWinEventHook(EVENT_OBJECT_TEXTSELECTIONCHANGED, EVENT_OBJECT_TEXTSELECTIONCHANGED, nullptr, selectionEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  Snapshot previous;
  ULONGLONG sampled = 0, heartbeat = 0;
  while (WaitForSingleObject(stopEvent, 0) == WAIT_TIMEOUT) {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) SetEvent(stopEvent);
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    const auto ticks = GetTickCount64();
    if (ticks - sampled >= 250 || focusChanged.exchange(false)) {
      sampled = ticks;
      auto current = snapshot(uia);
      const bool changed = !sameFocus(previous, current);
      if (previous.pid != current.pid || previous.image != current.image) emitCollector("app_activated", current);
      else if (previous.window != current.window || previous.title != current.title || previous.privacy != current.privacy) emitCollector("window_changed", current);
      else if (changed) emitCollector("ax_focus_changed", current);
      std::deque<Input> pending;
      { std::lock_guard<std::mutex> guard(inputMutex); pending.swap(inputs); }
      unsigned typing = 0;
      for (const auto& event : pending) {
        lastInputAt = event.at;
        inputObserved = true;
        if (changed || current.privacy != "normal" || !current.accessible || event.window != current.window || nowMs() - event.at > 1500) continue;
        GUITHREADINFO info{sizeof(info)};
        DWORD thread = GetWindowThreadProcessId(current.window, nullptr);
        if (!thread || !GetGUIThreadInfo(thread, &info) || info.hwndFocus != event.focus) continue;
        if (event.category == "input_activity") typing += event.count;
        else emitCollector(event.category, current, event.command);
      }
      if (typing) emitCollector("input_activity", current, "typing_burst", typing);
      previous = std::move(current);
    }
    if (ticks - heartbeat >= 1000) { heartbeat = ticks; emitCollector("heartbeat", previous); }
    MsgWaitForMultipleObjects(1, &stopEvent, FALSE, 30, QS_ALLINPUT);
  }
  if (focusHook) UnhookWinEvent(focusHook);
  if (selectionHook) UnhookWinEvent(selectionHook);
  if (textSelectionHook) UnhookWinEvent(textSelectionHook);
  if (keyboardHook) UnhookWindowsHookEx(keyboardHook);
  if (mouseHook) UnhookWindowsHookEx(mouseHook);
  focusHook = nullptr; keyboardHook = nullptr; mouseHook = nullptr;
  return 0;
}

class ClipboardLock {
public:
  bool opened = OpenClipboard(nullptr) != FALSE;
  ~ClipboardLock() { if (opened) CloseClipboard(); }
};

bool privacyMarker() {
  const wchar_t* markers[] = {L"ExcludeClipboardContentFromMonitorProcessing", L"Clipboard Viewer Ignore", L"org.nspasteboard.ConcealedType",
    L"org.nspasteboard.TransientType", L"org.nspasteboard.AutoGeneratedType"};
  for (const auto* marker : markers) if (IsClipboardFormatAvailable(RegisterClipboardFormatW(marker))) return true;
  const wchar_t* flags[] = {L"CanIncludeInClipboardHistory", L"CanUploadToCloudClipboard"};
  for (const auto* flag : flags) {
    UINT format = RegisterClipboardFormatW(flag);
    if (!IsClipboardFormatAvailable(format)) continue;
    HANDLE data = GetClipboardData(format);
    if (!data || GlobalSize(data) < sizeof(DWORD)) return true;
    const auto* value = static_cast<const DWORD*>(GlobalLock(data));
    if (!value) return true;
    const bool blocked = *value == 0;
    GlobalUnlock(data);
    if (blocked) return true;
  }
  return false;
}

void clipSkip(const char* reason) { emit("{\"type\":\"skip\",\"reason\":" + guzi::jsonString(reason) + "}"); }

void inspectClipboard(IUIAutomation* uia, DWORD sequence) {
  const auto context = snapshot(uia);
  if (!context.accessible || context.privacy != "normal") { clipSkip("private_or_unknown_source"); return; }
  ClipboardLock lock;
  if (!lock.opened) { clipSkip("busy"); return; }
  if (GetClipboardSequenceNumber() != sequence) { clipSkip("raced"); return; }
  if (privacyMarker()) { clipSkip("concealed"); return; }
  if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) { clipSkip("nontext"); return; }
  DWORD ownerPid = 0;
  GetWindowThreadProcessId(GetClipboardOwner(), &ownerPid);
  if (!ownerPid || ownerPid != context.pid) { clipSkip("unknown_source"); return; }
  HANDLE data = GetClipboardData(CF_UNICODETEXT);
  const SIZE_T bytes = data ? GlobalSize(data) : 0;
  if (!bytes || bytes > 20001 * sizeof(wchar_t) || bytes % sizeof(wchar_t)) { clipSkip("too_long"); return; }
  const auto* value = static_cast<const wchar_t*>(GlobalLock(data));
  if (!value) { clipSkip("unavailable"); return; }
  const SIZE_T capacity = bytes / sizeof(wchar_t);
  SIZE_T length = 0;
  while (length < capacity && value[length]) ++length;
  std::wstring text(value, length);
  GlobalUnlock(data);
  const auto clear = [&] { if (!text.empty()) SecureZeroMemory(text.data(), text.size() * sizeof(wchar_t)); };
  if (length == capacity || text.empty() || text.size() > 20000) { clear(); clipSkip("invalid_text"); return; }
  if (GetClipboardSequenceNumber() != sequence || privacyMarker() || GetForegroundWindow() != context.window) { clear(); clipSkip("raced"); return; }
  if (!guzi::calendarPattern(text)) { clear(); clipSkip("nopattern"); return; }
  const auto verified = snapshot(uia);
  if (!sameFocus(context, verified) || verified.privacy != "normal" || GetClipboardSequenceNumber() != sequence) { clear(); clipSkip("raced"); return; }
  emit("{\"type\":\"hit\",\"text\":" + jsonWideString(text) + ",\"app\":" + jsonWideString(context.name) + ",\"bundleId\":" + jsonWideString(context.bundle) + "}");
  clear();
}

int clipboardWatch(IUIAutomation* uia) {
  DWORD previous = GetClipboardSequenceNumber();
  emit("{\"type\":\"ready\"}");
  while (WaitForSingleObject(stopEvent, 250) == WAIT_TIMEOUT) {
    const auto sequence = GetClipboardSequenceNumber();
    if (!sequence || sequence == previous) continue;
    previous = sequence;
    inspectClipboard(uia, sequence);
  }
  return 0;
}

int clipboardFiles() {
  ClipboardLock lock;
  if (!lock.opened) return 3;
  const DWORD sequence = GetClipboardSequenceNumber();
  if (!IsClipboardFormatAvailable(CF_HDROP)) { emit("[]"); return 0; }
  const auto drop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
  if (!drop) return 3;
  const UINT count = DragQueryFileW(drop, 0xffffffff, nullptr, 0);
  if (count > 256) return 3;
  std::string result = "[";
  for (UINT i = 0; i < count; ++i) {
    const UINT length = DragQueryFileW(drop, i, nullptr, 0);
    if (!length || length > 32767) return 3;
    std::vector<wchar_t> path(static_cast<size_t>(length) + 1);
    if (DragQueryFileW(drop, i, path.data(), length + 1) != length) return 3;
    if (i) result += ",";
    result += jsonWideString(std::wstring(path.data(), length));
  }
  if (GetClipboardSequenceNumber() != sequence) return 3;
  emit(result + "]");
  return 0;
}

DWORD WINAPI stdinLifetime(void*) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  char buffer[64];
  DWORD read = 0;
  while (ReadFile(input, buffer, sizeof(buffer), &read, nullptr) && read) {
    // Stdin is a lifetime channel, never a source of capture content.
    SetEvent(stopEvent);
    return 0;
  }
  SetEvent(stopEvent);
  return 0;
}

DWORD WINAPI parentLifetime(void* data) {
  HANDLE parent = static_cast<HANDLE>(data);
  if (WaitForSingleObject(parent, INFINITE) == WAIT_OBJECT_0) ExitProcess(0);
  return 0;
}

DWORD parentPid(int argc, wchar_t** argv) {
  for (int i = 2; i + 1 < argc; ++i) if (std::wstring(argv[i]) == L"--parent-pid") {
    wchar_t* end = nullptr;
    const unsigned long parsed = wcstoul(argv[i + 1], &end, 10);
    if (!end || *end || !parsed || parsed == GetCurrentProcessId()) return 0;
    return parsed;
  }
  return 0;
}

DWORD launchingParentPid() {
  HANDLE processes = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (processes == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  DWORD parent = 0;
  if (Process32FirstW(processes, &entry)) {
    do {
      if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
    } while (Process32NextW(processes, &entry));
  }
  CloseHandle(processes);
  return parent;
}

bool attachParent(DWORD pid) {
  if (!pid) return false;
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!parent) return false;
  parentImage = processImage(pid);
  if (parentImage.empty()) { CloseHandle(parent); return false; }
  stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stopEvent) { CloseHandle(parent); return false; }
  HANDLE thread = CreateThread(nullptr, 0, parentLifetime, parent, 0, nullptr);
  if (!thread) { CloseHandle(parent); return false; }
  CloseHandle(thread);
  return true;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  setvbuf(stdout, nullptr, _IONBF, 0);
  if (argc < 2) return 2;
  const std::wstring command = argv[1];
  try {
    if (command == L"--self-test") { guzi::selfTest(); emit("{\"type\":\"self-test\",\"ok\":true,\"protocol\":1}"); return 0; }
    const bool watching = command == L"collect" || command == L"clipboard-watch";
    if (!attachParent(watching ? parentPid(argc, argv) : launchingParentPid())) return 3;
    if (command == L"app-info") {
      if (argc != 3) return 2;
      const auto path = canonicalPath(argv[2]);
      if (path.empty() || guzi::executableName(path).size() < 5 || guzi::executableName(path).substr(guzi::executableName(path).size() - 4) != L".exe") return 3;
      emit("{\"bundleId\":" + jsonWideString(guzi::identity(path)) + ",\"name\":" + jsonWideString(appName(path)) + ",\"path\":" + jsonWideString(path) + "}");
      return 0;
    }
    if (command == L"clipboard-files") return clipboardFiles();
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return 3;
    const auto uia = automation();
    if (command == L"snapshot") { emit(snapshotJson(snapshot(uia.Get()))); return 0; }
    if (command == L"capture-window") return argc == 4 ? captureWindow(uia.Get(), argv[2], argv[3]) : 2;
    if (command != L"collect" && command != L"clipboard-watch") return 2;
    HANDLE inputThread = CreateThread(nullptr, 0, stdinLifetime, nullptr, 0, nullptr);
    if (!inputThread) return 3;
    CloseHandle(inputThread);
    const int result = command == L"collect" ? collect(uia.Get()) : clipboardWatch(uia.Get());
    // Process exit closes the parent handle and terminates the blocking stdin reader.
    return result;
  } catch (...) {
    fputs("Windows native helper failed\n", stderr);
    return 3;
  }
}
