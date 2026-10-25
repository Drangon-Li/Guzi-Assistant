#pragma once
#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <iomanip>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>

namespace guzi {
inline std::wstring lower(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
  return value;
}

inline std::string hash(const std::wstring& value) {
  uint64_t result = 0xcbf29ce484222325ULL;
  for (wchar_t c : value) {
    // Hash UTF-16 units on every test host, including systems with 32-bit wchar_t.
    uint32_t cp = static_cast<uint32_t>(c);
    if (cp > 0xffff) {
      result = (result ^ (0xd800 + ((cp - 0x10000) >> 10))) * 0x100000001b3ULL;
      cp = 0xdc00 + ((cp - 0x10000) & 0x3ff);
    }
    result = (result ^ cp) * 0x100000001b3ULL;
  }
  std::ostringstream out;
  out << std::hex << std::setfill('0') << std::setw(16) << result;
  return out.str();
}

inline std::wstring normalizePath(std::wstring value) {
  if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) value = L"\\\\" + value.substr(8);
  else if (value.rfind(L"\\\\?\\", 0) == 0) value = value.substr(4);
  std::replace(value.begin(), value.end(), L'/', L'\\');
  return lower(value);
}

inline std::wstring executableName(const std::wstring& path) {
  const auto normalized = normalizePath(path);
  const auto pos = normalized.find_last_of(L'\\');
  return pos == std::wstring::npos ? normalized : normalized.substr(pos + 1);
}

inline std::wstring identity(const std::wstring& canonicalPath) {
  const auto digest = hash(normalizePath(canonicalPath));
  return L"win32:" + executableName(canonicalPath) + L":" + std::wstring(digest.begin(), digest.end());
}

inline bool browser(const std::wstring& exe) {
  return exe == L"chrome.exe" || exe == L"msedge.exe" || exe == L"firefox.exe" || exe == L"brave.exe" ||
    exe == L"vivaldi.exe" || exe == L"opera.exe" || exe == L"arc.exe" || exe == L"chromium.exe";
}

inline bool privateMarker(const std::wstring& text) {
  static const std::wregex pattern(L"incognito|inprivate|private browsing|private window|guest|isolated window|无痕|無痕|隐私|隱私|私密|访客|訪客|シークレット|プライベート|시크릿|프라이빗", std::regex::icase);
  return std::regex_search(text, pattern);
}

inline std::wstring hostOnly(std::wstring value) {
  value = lower(value);
  const auto scheme = value.find(L"://");
  if (scheme != std::wstring::npos) {
    if (value.substr(0, scheme) != L"http" && value.substr(0, scheme) != L"https") return L"";
    value.erase(0, scheme + 3);
  }
  const auto end = value.find_first_of(L"/?#");
  const auto authority = value.substr(0, end);
  if (authority.empty() || authority.size() > 255 || authority.find(L'@') != std::wstring::npos) return L"";
  for (wchar_t c : authority) if (std::iswspace(c) || c < 0x20 || c == L'\\' || c == L'\"' || c == L'\'') return L"";
  std::wstring host = authority;
  if (host.front() == L'[') {
    const auto close = host.find(L']');
    if (close == std::wstring::npos || close == 1) return L"";
    const auto port = host.substr(close + 1);
    if (!port.empty() && (port.front() != L':' || port.size() < 2 || port.find_first_not_of(L"0123456789", 1) != std::wstring::npos)) return L"";
    host = host.substr(1, close - 1);
    // Collector protocol deliberately excludes colon-containing hosts.
    return L"";
  }
  const auto colon = host.find(L':');
  if (colon != std::wstring::npos) {
    const auto port = host.substr(colon + 1);
    if (port.empty() || port.find_first_not_of(L"0123456789") != std::wstring::npos) return L"";
    host.resize(colon);
  }
  if (host.empty() || host.find_first_not_of(L"abcdefghijklmnopqrstuvwxyz0123456789.-") != std::wstring::npos ||
      host.front() == L'.' || host.find(L"..") != std::wstring::npos) return L"";
  if (host.back() == L'.') host.pop_back();
  return host;
}

inline std::wstring safeTitle(const std::wstring& value) {
  static const std::wregex urls(L"([a-z][a-z0-9+.-]*://|www\\.)[^\\s<>\"'`]+", std::regex::icase);
  static const std::wregex paths(L"([a-z0-9-]+\\.)+[a-z]{2,}/[^\\s<>\"'`]+", std::regex::icase);
  static const std::wregex query(L"\\?[A-Za-z0-9_.~%-]+=[^\\s]+", std::regex::icase);
  static const std::wregex callbacks(L"(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+|/)[^\\s<>\"'`]*", std::regex::icase);
  return std::regex_replace(std::regex_replace(std::regex_replace(std::regex_replace(value, urls, L"[hidden URL]"), paths, L"[hidden URL]"), callbacks, L"[hidden callback]"), query, L"[hidden query]").substr(0, 160);
}

inline bool calendarPattern(const std::wstring& value) {
  if (value.empty() || value.size() > 20000) return false;
  static const std::wregex date(L"([12][0-9]{3}[-/][01]?[0-9][-/][0-3]?[0-9]|[01]?[0-9]月[0-3]?[0-9][日号號]|today|tomorrow|tonight|next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|今天|今日|明天|明日|后天|後天|周[一二三四五六日天]|週[一二三四五六日天]|星期[一二三四五六日天])", std::regex::icase);
  static const std::wregex time(L"([0-2]?[0-9][:：][0-5][0-9]|[0-2]?[0-9]\\s*(am|pm)|[上下]午.{0,3}[0-9一二三四五六七八九十]+[点點时時]|[0-9一二三四五六七八九十]+[点點])", std::regex::icase);
  static const std::wregex action(L"meeting|appointment|deadline|submit|due|remind|会议|會議|开会|開會|提交|截止|提醒|预约|預約|交付|交报告|交報告", std::regex::icase);
  return std::regex_search(value, date) && (std::regex_search(value, time) || std::regex_search(value, action));
}

inline std::string jsonString(const std::string& value) {
  std::ostringstream out;
  out << '"';
  for (unsigned char c : value) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (c < 0x20) out << "\\u" << std::hex << std::setfill('0') << std::setw(4) << static_cast<unsigned>(c) << std::dec;
        else out << c;
    }
  }
  out << '"';
  return out.str();
}

inline void selfTest() {
  const auto check = [](bool condition) { if (!condition) throw std::runtime_error("native protocol self-test failed"); };
  check(identity(L"C:\\Apps\\Chrome.EXE") == identity(L"\\\\?\\C:\\Apps\\chrome.exe"));
  check(identity(L"C:\\A\\chrome.exe") != identity(L"C:\\B\\chrome.exe"));
  check(identity(L"C:\\Apps\\chrome.exe").rfind(L"win32:chrome.exe:", 0) == 0);
  check(hostOnly(L"https://example.com/path?token=secret#fragment") == L"example.com");
  check(hostOnly(L"https://user:password@example.com/private").empty());
  check(hostOnly(L"chrome://settings").empty());
  check(hostOnly(L"example.com:443/private") == L"example.com");
  check(hostOnly(L"example.com evil.test").empty());
  check(privateMarker(L"Example - InPrivate - Microsoft Edge"));
  check(privateMarker(L"无痕模式"));
  check(!privateMarker(L"Example - Google Chrome"));
  check(calendarPattern(L"明天下午3点开会"));
  check(calendarPattern(L"Submit report tomorrow at 14:30"));
  check(!calendarPattern(L"secret-api-key-1234"));
  check(!calendarPattern(L"tomorrow is another day"));
  check(safeTitle(L"Title https://example.com/?token=secret").find(L"secret") == std::wstring::npos);
  check(safeTitle(L"Title example.com/private").find(L"private") == std::wstring::npos);
  check(safeTitle(L"Title file:///private/file").find(L"private") == std::wstring::npos);
  check(jsonString("a\n\"b\\c") == "\"a\\n\\\"b\\\\c\"");
}
}  // namespace guzi
