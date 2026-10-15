// wps2pdf —— 用 WPS 内核把 Word 文档转 PDF（Linux ARM64）
//
// 原理：通过 WPS 的二次开发接口 librpcwpsapi_sysqt5.so（类 COM 接口）驱动
// WPS 以 -automation 模式启动，调用 Documents.Open + Document.SaveAs(path, 17)。
// 会话序列逆向自 PageOffice 客户端（详见同目录 REVERSE-ENGINEERING.md）。
//
// 用法：LD_LIBRARY_PATH=/opt/kingsoft/wps-office/office6 wps2pdf <输入.docx> <输出.pdf>
// 退出码：0 成功；非 0 失败（调用方应回退到其它后端）。
//
// 注意：安全箱（TSD）会加密受控进程写盘的文档，所以中间产物落 /dev/shm（tmpfs），
//       再由本进程（非受控）拷贝到目标路径，保证输出是明文 PDF。
#include <dlfcn.h>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <signal.h>
#include <string>
#include <vector>
#include <ctime>
#include <dirent.h>

struct VARIANT { uint16_t vt; uint16_t r1, r2, r3; uint64_t val; uint8_t pad[8]; }; // 24B (x64 tagVARIANT)
struct GUID { uint32_t d1; uint16_t d2, d3; uint8_t d4[8]; };
typedef int32_t HRESULT;

static const uint64_t DISP_E_PARAMNOTFOUND = 0x80020004ULL;
static const char* WPS_LIB = "/opt/kingsoft/wps-office/office6/librpcwpsapi_sysqt5.so";
static const char* WPS_BIN = "/opt/kingsoft/wps-office/office6/wps";

static std::string g_err;

// UTF-8 -> UTF-16 (含 CJK 与代理对)
static std::vector<uint16_t> utf16(const std::string& s) {
  std::vector<uint16_t> out;
  size_t i = 0, n = s.size();
  while (i < n) {
    unsigned char c = s[i];
    uint32_t cp;
    if (c < 0x80) { cp = c; i += 1; }
    else if ((c >> 5) == 0x6 && i + 1 < n) { cp = ((c & 0x1F) << 6) | (s[i+1] & 0x3F); i += 2; }
    else if ((c >> 4) == 0xE && i + 2 < n) { cp = ((c & 0x0F) << 12) | ((s[i+1] & 0x3F) << 6) | (s[i+2] & 0x3F); i += 3; }
    else if ((c >> 3) == 0x1E && i + 3 < n) {
      cp = ((c & 0x07) << 18) | ((s[i+1] & 0x3F) << 12) | ((s[i+2] & 0x3F) << 6) | (s[i+3] & 0x3F); i += 4;
    } else { cp = 0xFFFD; i += 1; }
    if (cp <= 0xFFFF) out.push_back((uint16_t)cp);
    else { cp -= 0x10000; out.push_back(0xD800 + (cp >> 10)); out.push_back(0xDC00 + (cp & 0x3FF)); }
  }
  return out;
}
static inline void* vtfn(void* o, int i) { return (*(void***)o)[i]; }

// 优雅退出"本次"拉起的 WPS 自动化进程。
// 识别方式：cmdline 里含 `-automation` 且 `rpcserverport=/wpsrpc-<epoch>-<rand>`，
// 且 epoch 落在本次运行窗口内。只用 SIGTERM（SIGKILL 会带崩桌面会话）。
static void kill_our_wps(time_t start_epoch) {
  DIR* d = opendir("/proc");
  if (!d) return;
  struct dirent* e;
  const char* key = "rpcserverport=/wpsrpc-";
  const size_t keylen = strlen(key);
  while ((e = readdir(d)) != nullptr) {
    if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
    char path[300]; snprintf(path, sizeof path, "/proc/%s/cmdline", e->d_name);
    FILE* f = fopen(path, "rb");
    if (!f) continue;
    char cl[4096]; size_t n = fread(cl, 1, sizeof cl - 1, f); cl[n] = 0; fclose(f);
    // cmdline 是 NUL 分隔的，必须按长度搜（strstr 会在第一个 NUL 处停下）
    if (!memmem(cl, n, "-automation", 11)) continue;
    const char* q = (const char*)memmem(cl, n, key, keylen);
    if (!q) continue;
    long ep = strtol(q + keylen, nullptr, 10);
    if (ep >= (long)start_epoch - 5) {
      pid_t pid = (pid_t)atoi(e->d_name);
      kill(pid, SIGTERM);
      fprintf(stderr, "已优雅退出本次 WPS pid=%d\n", (int)pid);
    }
  }
  closedir(d);
}

int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "用法: wps2pdf <输入.docx> <输出.pdf>\n"); return 2; }
  const char* in = argv[1];
  const char* out = argv[2];
  if (access(in, R_OK) != 0) { fprintf(stderr, "输入文件不可读: %s\n", in); return 2; }

  void* h = dlopen(WPS_LIB, RTLD_NOW | RTLD_GLOBAL);
  if (!h) { fprintf(stderr, "dlopen 失败: %s\n", dlerror()); return 3; }

  typedef uint16_t* (*alloc_t)(const uint16_t*, int);
  typedef uint16_t* (*alloc0_t)(const uint16_t*);
  typedef HRESULT (*create_t)(void**);
  alloc_t  sallocLen = (alloc_t) dlsym(h, "_XSysAllocStringLen");
  alloc0_t salloc    = (alloc0_t)dlsym(h, "_XSysAllocString");
  create_t create    = (create_t) dlsym(h, "createWpsRpcInstance");
  if (!sallocLen || !salloc || !create) { fprintf(stderr, "缺少 WPS 接口符号\n"); return 3; }

  void* client = nullptr;
  if (create(&client) || !client) { fprintf(stderr, "createWpsRpcInstance 失败\n"); return 4; }

  // 1) 设置 WPS 可执行路径 + 启动参数（与 PageOffice 一致）
  { auto w = utf16(WPS_BIN); w.push_back(0); ((HRESULT(*)(void*,uint16_t*))vtfn(client,5))(client, salloc(w.data())); }
  const char* args[3] = {"-shield", "-multiply", "-embedding"};
  uint16_t* av[4] = {nullptr, nullptr, nullptr, nullptr};
  for (int i = 0; i < 3; i++) { auto w = utf16(args[i]); w.push_back(0); av[i] = salloc(w.data()); }
  ((HRESULT(*)(void*,int,uint16_t**))vtfn(client,6))(client, 4, av);

  // 2) 创建 Application（会拉起 wps -automation -rpcserverport=...）
  void* app = nullptr;
  ((HRESULT(*)(void*,void**))vtfn(client,2))(client, &app);
  if (!app) { fprintf(stderr, "创建 WPS Application 失败\n"); return 4; }

  sleep(2);
  time_t start_epoch = time(nullptr);   // 用于识别"本次"拉起的 WPS（rpcserverport 里带 epoch）

  // 3) Documents
  void* docs = nullptr;
  HRESULT hr = ((HRESULT(*)(void*,void**))vtfn(app,11))(app, &docs);
  if (hr || !docs) { fprintf(stderr, "get_Documents 失败 hr=0x%08X\n", (unsigned)hr); return 5; }

  // 4) Open：16 个 VARIANT* + 1 个 IDispatch**
  VARIANT missing = {10, 0, 0, 0, DISP_E_PARAMNOTFOUND, {0}};
  VARIANT vfile = {0}, vvis = {11, 0, 0, 0, 0, {0}};
  {
    auto w = utf16(in);
    vfile.vt = 8; vfile.val = (uint64_t)sallocLen(w.data(), (int)w.size());
  }
  void* doc = nullptr;
  {
    typedef HRESULT (*open_t)(void*,
      VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,
      VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*,VARIANT*, void**);
    open_t fn = (open_t)vtfn(docs, 22);
    hr = fn(docs, &vfile, &missing, &missing, &missing, &missing, &missing, &missing, &missing,
                  &missing, &missing, &vvis, &missing, &missing, &missing, &missing, &missing, &doc);
  }
  if (hr || !doc) { fprintf(stderr, "Documents.Open 失败 hr=0x%08X\n", (unsigned)hr); return 6; }

  // 5) SaveAs 到 /dev/shm（明文），再拷到目标路径
  char tmp[256];
  snprintf(tmp, sizeof tmp, "/dev/shm/yyx-wps-%d-%ld.pdf", (int)getpid(), (long)time(nullptr));
  {
    auto w = utf16(tmp); w.push_back(0);
    uint16_t* bpdf = sallocLen(w.data(), (int)w.size() - 1);
    typedef HRESULT (*save_t)(void*,uint16_t*,long,long,long,long,long,long,long,long,long,long,long,long,long,VARIANT*);
    save_t fn = (save_t)vtfn(doc, 417);
    hr = fn(doc, bpdf, 17, 0, 0, 0, 0, 0, 0, 0, -1, 1, -1, -1, 0, &missing);
  }
  if (hr) { fprintf(stderr, "SaveAs 失败 hr=0x%08X\n", (unsigned)hr); return 7; }

  // 6) 收尾：等文件落盘，拷到目标（本进程非受控，保持明文），杀掉本次拉起的 WPS
  int rc = 0;
  for (int i = 0; i < 50; i++) { FILE* f = fopen(tmp, "rb"); if (f) { fclose(f); break; } usleep(100000); }
  {
    FILE* fi = fopen(tmp, "rb");
    if (!fi) { fprintf(stderr, "未生成 PDF: %s\n", tmp); rc = 8; }
    else {
      FILE* fo = fopen(out, "wb");
      if (!fo) { fclose(fi); fprintf(stderr, "无法写入输出: %s\n", out); rc = 8; }
      else {
        char buf[65536]; size_t n;
        while ((n = fread(buf, 1, sizeof buf, fi)) > 0) fwrite(buf, 1, n, fo);
        fclose(fo);
      }
      fclose(fi);
    }
    unlink(tmp);
  }

  // 7) 退出本次 WPS 进程：只 SIGTERM（绝不用 SIGKILL——实测会把 UKUI 会话带崩）。
  //    用 rpcserverport 里的 epoch 匹配"本次"实例（getProcessPid 返回无效值，父进程是 1）。
  kill_our_wps(start_epoch);

  // 直接 _exit：跳过库析构（实测正常 return 时会在 WPS 库析构阶段 SIGBUS）
  fflush(nullptr);
  _exit(rc);
}
