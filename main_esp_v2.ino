// ============================================================================
//  ESP32 Industrial Production Counter Firmware v2.0
// ============================================================================
//  Complete refactor of main_esp.ino for efficiency, readability, and

//  Key improvements over v1:
//    - Zero-heap-allocation crypto (HMAC hex via stack buffers)
//    - Persistent TLS clients per FreeRTOS task (fewer handshakes)
//    - Eliminated duplicate UART initialization
//    - Fixed PWM re-attach on every buzzer toggle
//    - Removed dead code paths
//    - Fixed HTTP resource leak in syncTimeHTTP()
//    - ArduinoJson serialization for heartbeat body (replaces manual concat)
//    - Organized into clearly labeled sections

// ════════════════════════════════════════════════════════════════════════════
//  SECTION 1: INCLUDES
// ════════════════════════════════════════════════════════════════════════════

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LittleFS.h>          // FIX #11: Better wear leveling than SPIFFS
#include <Preferences.h>       // FIX #8: NVS Persistence
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <deque>               // FIX #10: RAM Buffer
#include <esp_task_wdt.h>      // FIX #12: WDT Handling
#include <esp_timer.h>         // FIX: Explicit include for esp_timer_get_time()
#include <esp_wifi.h>          // For Band Steering mitigations
#include <mbedtls/md.h>        // For HMAC-SHA256
#include <time.h>


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 2: CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

// --- Device Identity (CHANGE THIS FOR EACH DEVICE) ---
// Format: {GROUP}-{TYPE}-{NUMBER}  e.g. "LINE1-CT-01", "PRESS-CT-02"
#define MY_DEVICE_ID "YOUR-DEVICE-ID"

// --- WiFi Credentials (FIX #15: Multi-AP Failover) ---
struct APConfig {
  const char *ssid;
  const char *pass;
};

static const APConfig AP_LIST[] = {
    {"YOUR_PRIMARY_SSID",   "YOUR_PRIMARY_PASSWORD"},
    {"YOUR_BACKUP_SSID_1",  "YOUR_BACKUP_PASSWORD_1"},
    {"YOUR_BACKUP_SSID_2",  "YOUR_BACKUP_PASSWORD_2"},
    {"YOUR_BACKUP_SSID_3",  "YOUR_BACKUP_PASSWORD_3"},
    {"YOUR_BACKUP_SSID_4",  ""}
};
static const int NUM_APS = sizeof(AP_LIST) / sizeof(AP_LIST[0]);

// --- Server Endpoints ---
// Replace with your VPS IP or domain name.
static const char *SERVER_URL           = "https://YOUR_SERVER_IP_OR_DOMAIN/api/upload";
static const char *SERVER_LOG_URL       = "https://YOUR_SERVER_IP_OR_DOMAIN/api/device/log";
static const char *SERVER_HEARTBEAT_URL = "https://YOUR_SERVER_IP_OR_DOMAIN/api/device/heartbeat";

// --- Security ---
// Generate a strong random key (32+ characters). Keep this secret.
// Must match MASTER_KEY in your server's .env file.
static const char *MASTER_KEY = "YOUR_STRONG_RANDOM_MASTER_KEY_HERE";
// Per-device key derived at boot — 64 hex chars + null.
// Stored as char[] to avoid String heap allocation on every signature call.
static char deviceKeyHex[65] = {0};

// --- TLS Certificate ---
// Paste the output of the following command run on your VPS:
//   cat /etc/ssl/certs/nginx-selfsigned.crt
// If using a CA-signed certificate (Let's Encrypt etc.), paste the full chain.
// Switch client.setInsecure() → client.setCACert(SERVER_CERT) once populated.
static const char *SERVER_CERT = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_YOUR_VPS_TLS_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF";

// --- Time Settings (India: UTC+5:30 = 19800 sec) ---
static const long  GMT_OFFSET_SEC      = 19800;
static const int   DAYLIGHT_OFFSET_SEC = 0;
static const char *NTP_SERVER1 = "time.google.com";
static const char *NTP_SERVER2 = "time.cloudflare.com";
static const char *NTP_SERVER3 = "pool.ntp.org";

// --- Pin Definitions ---
static const int PIN_PROXIMITY = 13;  // Input (Interrupt — FALLING edge)
static const int PIN_IR_SENSOR = 27;  // Input (Chain end detection)
static const int PIN_BUZZER    = 18;  // Output (PWM, 2kHz)
static const int PIN_QR_RX     = 16;  // UART2 RX
static const int PIN_QR_TX     = 17;  // UART2 TX

// --- Timing Constants ---
// FIX #9: Use uint64_t for time everywhere to handle 49-day millis() overflow
static const uint64_t DEBOUNCE_TIME_MS     = 500;    // Max 1.5 units/sec
static const uint64_t CHAIN_END_TIMEOUT_MS = 30000;  // 30s silence + IR clear
static const uint64_t QR_DEBOUNCE_MS       = 10000;  // 10s same-QR ignore
static const long     BATCH_START_STROKES  = 5;       // Anti-vibration threshold

// --- Buffer Limits ---
static const size_t MAX_RAM_BUFFER_SIZE = 500;  // FIX #10: ~32KB RAM max

// --- NTP Validity Epoch ---
// 2023-01-01 00:00:00 UTC — timestamps before this are considered invalid.
static const uint64_t MIN_VALID_EPOCH = 1672531200ULL;

// --- Debug Flags ---
// Uncomment to enable WiFi network scanning at boot (adds 3-6s to startup).
// #define DEBUG_WIFI_SCAN


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 3: TYPE DEFINITIONS
// ════════════════════════════════════════════════════════════════════════════

// --- State Machine ---
enum SystemState {
  IDLE,
  MONITORING,
  WAITING_FOR_NEXT_QR
};

// --- Batch Record (sent to server or saved to flash) ---
struct BatchData {
  uint64_t startTime;       // Epoch seconds (NTP)
  uint64_t endTime;         // Epoch seconds (NTP)
  uint64_t startSysTime;    // Monotonic milliseconds
  uint64_t endSysTime;      // Monotonic milliseconds
  uint32_t duration;        // Computed duration in seconds
  char     lotId[64];
  long     unitsProduced;
  char     batch_uuid[37];  // UUIDv4 for idempotency
  char     notes[32];       // Optional tag e.g. "PARTIAL_RECOVERY"
};

// --- FIX #13: RTC Memory for High-Frequency Persistence (No Flash Wear) ---
struct BatchStateRTC {
  uint32_t      magic;      // Magic number to detect valid RTC (0xDEADBEEF)
  uint64_t      startTime;
  char          lotId[64];
  char          lastQr[64]; // Survives soft resets to preserve debounce state
  unsigned long count;
  uint32_t      crc;        // CRC32 validation
};

// --- Log Entry (non-blocking log queue) ---
struct LogEntry {
  char message[256];
};


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 4: GLOBAL STATE
// ════════════════════════════════════════════════════════════════════════════

// --- State Machine ---
static SystemState    currentState       = IDLE;
static String         currentLotId       = "";
static uint64_t       batchStartTime     = 0;     // Epoch
static uint64_t       batchStartSysTime  = 0;     // Monotonic ms
static uint64_t       batchEndTime       = 0;
static volatile unsigned long strokeCount = 0;     // Modified in ISR
static volatile uint64_t lastDebounceTime = 0;     // ISR debounce
static unsigned long  strokesAtStateChange = 0;    // FIX #5: Relative tracking
static unsigned long  lastSavedStrokeCount = 0;    // NVS save optimization
static volatile uint64_t lastStrokeSystemTime = 0; // Chain-end timeout reference
static bool           isChainEnded       = false;
static uint64_t       lastQrScanTime     = 0;
static String         lastQrContent      = "";
static bool           restoredFromReboot = false;

// --- RTC Persistence (FIX #13) ---
RTC_NOINIT_ATTR BatchStateRTC rtcState;
static const uint32_t RTC_MAGIC = 0xDEADBEEF;

// --- Atomicity (FIX #6) ---
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

// --- FreeRTOS Handles ---
static QueueHandle_t     uploadQueue      = NULL;
static SemaphoreHandle_t offlineFileMutex = NULL;
static QueueHandle_t     logQueue         = NULL;

// --- NVS Persistence (FIX #8) ---
static Preferences preferences;

// --- Status & Error Tracking ---
static volatile int lastUploadHttpCode = 200;

// --- FIX #14: Retroactive Status Correction ---
// Accumulate seconds since last successful heartbeat.
static uint32_t activeSecsPool = 0;
static uint32_t idleSecsPool   = 0;
static uint64_t lastSecondTick = 0;

// --- WiFi Failover ---
static int currentApIndex = 0;


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 5: FORWARD DECLARATIONS & MACROS
// ════════════════════════════════════════════════════════════════════════════

// Remote logging: sends to Serial AND to the remote panel simultaneously.
// sendLog() is non-blocking — it enqueues and returns immediately.
void sendLog(const String &message);
#define remoteLog(msg) do { Serial.println(msg); sendLog(msg); } while(0)


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 6: UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// --- 64-bit System Time (FIX #7 & #9) ---
// Uses esp_timer (microsecond, 64-bit, survives soft resets) instead of
// millis() which overflows at 49 days.
uint64_t getSystemMillis() {
  return (uint64_t)(esp_timer_get_time() / 1000ULL);
}

// --- Epoch Time ---
uint64_t getEpochTime() {
  time_t now;
  time(&now);
  return (uint64_t)now;
}

// --- Device Identity ---
// Returns a compile-time constant pointer — zero allocation.
const char* getDeviceId() {
  return MY_DEVICE_ID;
}

// --- Hex Conversion Helper ---
// Converts raw bytes to a hex string in a caller-provided buffer.
// outHex must be at least (len * 2 + 1) bytes.
static void bytesToHex(const byte *data, size_t len, char *outHex) {
  for (size_t i = 0; i < len; i++) {
    sprintf(outHex + i * 2, "%02x", data[i]);
  }
  outHex[len * 2] = '\0';
}

// --- HMAC-SHA256 Helper ---
// Simple single-data HMAC for key derivation.
static void computeHMAC(const void *key, size_t keyLen,
                         const void *data, size_t dataLen,
                         byte *out32) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char *)key, keyLen);
  mbedtls_md_hmac_update(&ctx, (const unsigned char *)data, dataLen);
  mbedtls_md_hmac_finish(&ctx, out32);
  mbedtls_md_free(&ctx);
}

// --- Request Signature Generation ---
// Computes HMAC-SHA256(key, payload + timestamp_str) and writes 64 hex
// chars + null to outHex65. Uses incremental HMAC update — zero
// concatenation, zero heap allocation.
void generateSignature(const char *payload, size_t payloadLen,
                       uint64_t timestamp, const char *key,
                       char *outHex65) {
  // Audit Fix #11: uint32_t cast — Unix epoch fits until 2038.
  char tsStr[16];
  int tsLen = snprintf(tsStr, sizeof(tsStr), "%u", (uint32_t)timestamp);

  byte hmacResult[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char *)key, strlen(key));
  mbedtls_md_hmac_update(&ctx, (const unsigned char *)payload, payloadLen);
  if (timestamp > 0) {
    mbedtls_md_hmac_update(&ctx, (const unsigned char *)tsStr, tsLen);
  }
  mbedtls_md_hmac_finish(&ctx, hmacResult);
  mbedtls_md_free(&ctx);

  bytesToHex(hmacResult, 32, outHex65);
}

// --- UUID Generation ---
String generateUUID() {
  uint32_t r1 = esp_random();
  uint32_t r2 = esp_random();
  uint32_t r3 = esp_random();
  uint32_t r4 = esp_random();

  char uuid[37];
  snprintf(uuid, sizeof(uuid), "%08lx-%04lx-%04lx-%04lx-%04lx%08lx",
           (uint32_t)r1, (uint32_t)(r2 >> 16),
           (uint32_t)((r2 & 0x0FFF) | 0x4000),         // Version 4
           (uint32_t)(((r3 >> 16) & 0x3FFF) | 0x8000),  // Variant 1
           (uint32_t)(r3 & 0xFFFF), (uint32_t)r4);
  return String(uuid);
}

// --- Per-Device Key Derivation ---
// HMAC-SHA256(MASTER_KEY, device_id) → 64 hex chars stored in deviceKeyHex.
void derivePerDeviceKey() {
  const char *deviceId = getDeviceId();
  byte hmacResult[32];
  computeHMAC(MASTER_KEY, strlen(MASTER_KEY),
              deviceId, strlen(deviceId), hmacResult);
  bytesToHex(hmacResult, 32, deviceKeyHex);
  Serial.println("Per-Device HMAC Key Derived.");
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 7: ISR & ATOMIC HELPERS
// ════════════════════════════════════════════════════════════════════════════

// --- Interrupt Service Routine ---
// Runs in IRAM for maximum reliability. 500ms debounce prevents
// phantom-counting from machine vibration (supports up to 1.5 units/sec).
void IRAM_ATTR onStrokeDetected() {
  // FIX #7: ISR-safe time from esp_timer (survives soft resets)
  uint64_t currentTime = (uint64_t)(esp_timer_get_time() / 1000ULL);

  // Safety: if time goes backwards (overflow or deep sleep), reset debounce
  if (currentTime < lastDebounceTime) {
    lastDebounceTime = 0;
  }

  if ((currentTime - lastDebounceTime) > DEBOUNCE_TIME_MS) {
    portENTER_CRITICAL_ISR(&mux); // FIX #6: Atomicity
    strokeCount++;
    lastStrokeSystemTime = currentTime;

    // FIX #13: Fast save to RTC (no flash wear)
    rtcState.count = strokeCount;

    portEXIT_CRITICAL_ISR(&mux);
    lastDebounceTime = currentTime;
  }
}

// --- Atomic Read ---
unsigned long safeGetStrokeCount() {
  portENTER_CRITICAL(&mux);
  unsigned long count = strokeCount;
  portEXIT_CRITICAL(&mux);
  return count;
}

// --- Atomic Reset ---
void safeResetStrokeCount() {
  portENTER_CRITICAL(&mux);
  strokeCount = 0;
  portEXIT_CRITICAL(&mux);
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 8: BUZZER
// ════════════════════════════════════════════════════════════════════════════

// PWM buzzer control. ledcAttach() is called once in setup(); here we only
// toggle duty cycle to avoid reconfiguring the timer hardware on every call.
void triggerBuzzer(bool active) {
  if (active) {
    ledcWrite(PIN_BUZZER, 128); // 50% duty cycle = audible 2kHz tone
  } else {
    ledcWrite(PIN_BUZZER, 0);   // 0% duty = silent
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 9: PERSISTENCE — NVS, RTC, LittleFS
// ════════════════════════════════════════════════════════════════════════════

// --- CRC32 helper for RTC state validation (FIX #13) ---
static uint32_t computeRTCCRC(const BatchStateRTC &s) {
  const uint8_t *data = (const uint8_t *)&s;
  uint32_t crc = 0xFFFFFFFF;
  size_t offset = offsetof(BatchStateRTC, startTime);
  size_t length = sizeof(BatchStateRTC) - offset - sizeof(uint32_t);
  for (size_t i = offset; i < offset + length; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++)
      crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc;
}

// --- Initialize RTC for a NEW batch ---
void initRTCState() {
  rtcState.magic = RTC_MAGIC;
  rtcState.startTime = batchStartTime;
  strncpy(rtcState.lotId, currentLotId.c_str(), 63);
  rtcState.lotId[63] = '\0';
  strncpy(rtcState.lastQr, lastQrContent.c_str(), 63);
  rtcState.lastQr[63] = '\0';
  rtcState.count = 0;
  rtcState.crc = computeRTCCRC(rtcState);
}

// --- Sync non-count RTC vars mid-batch ---
void saveBatchStateRTC() {
  rtcState.startTime = batchStartTime;
  strncpy(rtcState.lotId, currentLotId.c_str(), 63);
  rtcState.lotId[63] = '\0';
  strncpy(rtcState.lastQr, lastQrContent.c_str(), 63);
  rtcState.lastQr[63] = '\0';
  rtcState.crc = computeRTCCRC(rtcState);
}

// --- NVS Flash Save ---
void saveBatchStateNVS() {
  preferences.putULong("count", safeGetStrokeCount());
  preferences.putULong("stateChg", strokesAtStateChange);
  preferences.putString("lot", currentLotId);
  preferences.putULong64("start", batchStartTime);
  preferences.putBool("valid", true);
  Serial.println("State saved to NVS Flash (Long-term backup).");
}

// --- NVS Flash Clear ---
void clearBatchStateNVS() {
  preferences.putBool("valid", false);
  preferences.putULong("count", 0);
  rtcState.magic = 0; // Invalidate RTC too
}

// --- LittleFS Init (FIX #11) ---
void initFileSystem() {
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS Mount Failed");
    return;
  }
  Serial.println("LittleFS Mounted");
}

// --- Save batch to offline flash storage ---
void saveToOffline(BatchData &data) {
  if (xSemaphoreTake(offlineFileMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    Serial.println("[WARN] offlineFileMutex timeout — skipping flash save.");
    // DATA IS STILL SAFE: exists in caller's struct and/or upload queue.
    return;
  }

  File file = LittleFS.open("/offline.json", FILE_APPEND);
  if (!file) {
    Serial.println("Failed to open offline file");
    xSemaphoreGive(offlineFileMutex);
    return;
  }

  // Serialize to stack buffer — no heap allocation.
  StaticJsonDocument<512> doc;
  doc["start_time"]     = data.startTime;
  doc["end_time"]       = data.endTime;
  doc["duration"]       = data.duration;
  // Save system time offsets for retroactive epoch calculation after reconnect.
  doc["start_sys_time"] = data.startSysTime;
  doc["end_sys_time"]   = data.endSysTime;
  doc["lot_id"]         = data.lotId;
  doc["units_produced"] = data.unitsProduced;
  doc["batch_uuid"]     = data.batch_uuid;
  if (data.notes[0] != '\0')
    doc["notes"] = data.notes;

  char line[512];
  serializeJson(doc, line, sizeof(line));
  file.println(line);
  file.close();
  xSemaphoreGive(offlineFileMutex);
  Serial.println("Saved to Flash.");
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 10: BATCH DATA PIPELINE
// ════════════════════════════════════════════════════════════════════════════

// --- Queue a completed batch for upload ---
void queueBatchData(String lotId, long units, uint64_t startT,
                    uint64_t startSys, uint64_t endT, uint64_t endSys,
                    const char *deviceId, String batchUuid, String notes = "") {
  BatchData data;
  data.startTime    = startT;
  data.startSysTime = startSys;
  data.endTime      = endT;
  data.endSysTime   = endSys;

  // Duration calculation with post-reboot awareness.
  // FIX: Prefer epoch-based when BOTH timestamps are valid NTP values.
  // After a soft reboot, batchStartSysTime resets to near-0, making
  // monotonic sys-time unreliable for duration.
  if (startT >= MIN_VALID_EPOCH && endT >= MIN_VALID_EPOCH && endT > startT) {
    data.duration = (uint32_t)(endT - startT);
  } else if (!restoredFromReboot && endSys > startSys) {
    data.duration = (uint32_t)((endSys - startSys) / 1000ULL);
  } else {
    data.duration = (uint32_t)((endSys > startSys ? endSys - startSys : 0) / 1000ULL);
  }

  // Sanity: warn if implausibly short (max ~1.5 units/sec)
  if (units > 0 && data.duration < 2 && units > 3) {
    Serial.printf("[WARN] Suspiciously short batch: %ld units in %u sec. "
                  "start_epoch=%llu end_epoch=%llu start_sys=%llu end_sys=%llu\n",
                  units, data.duration, startT, endT, startSys, endSys);
  }

  data.unitsProduced = units;
  strncpy(data.lotId, lotId.c_str(), sizeof(data.lotId) - 1);
  data.lotId[sizeof(data.lotId) - 1] = '\0';
  strncpy(data.batch_uuid, batchUuid.c_str(), 36);
  data.batch_uuid[36] = '\0';
  strncpy(data.notes, notes.c_str(), sizeof(data.notes) - 1);
  data.notes[sizeof(data.notes) - 1] = '\0';

  // ACID Durability: immediately commit to flash BEFORE deleting NVS backup.
  // Prevents data loss on brownout/crash. uploadTask picks it up via
  // processOfflineData().
  saveToOffline(data);
}

// --- Reset all batch state ---
void resetBatch() {
  safeResetStrokeCount();
  strokesAtStateChange = 0;
  currentLotId         = "";
  batchStartTime       = 0;
  batchStartSysTime    = 0;
  batchEndTime         = 0;
  lastSavedStrokeCount = 0;
  restoredFromReboot   = false;

  // FIX: Invalidate RTC magic immediately on every batch reset.
  // Prevents a crash in the batch-transition window from restoring
  // the OLD lot on reboot.
  rtcState.magic = 0x00000000;
}

// --- Finish current batch and optionally start a new one ---
void finishAndStartNewBatch(String newLotId) {
  batchEndTime = getEpochTime();

  // FIX: Mark endTime as 0 (explicit invalid) if NTP wasn't synced at close.
  // This makes queueBatchData fall through to sys-time duration, and
  // uploadTask's retroactive correction computes the correct epoch end_time.
  if (batchEndTime < MIN_VALID_EPOCH || batchEndTime <= batchStartTime) {
    batchEndTime = 0;
  }

  uint64_t batchEndSys = getSystemMillis();
  triggerBuzzer(false);

  if (currentLotId == "")
    currentLotId = "Unknown";

  long finalStrokes = safeGetStrokeCount();

  if (finalStrokes > 0) {
    String uuid = generateUUID();
    queueBatchData(currentLotId, finalStrokes, batchStartTime,
                   batchStartSysTime, batchEndTime, batchEndSys,
                   getDeviceId(), uuid);
  } else {
    Serial.println("Batch had 0 units. Discarding without uploading.");
  }

  clearBatchStateNVS();
  resetBatch();

  currentLotId = newLotId;
  if (newLotId != "") {
    batchStartTime = getEpochTime();
    if (batchStartTime < MIN_VALID_EPOCH)
      batchStartTime = 0;
    batchStartSysTime = getSystemMillis();
    currentState = MONITORING;
    saveBatchStateNVS();
    remoteLog("[BATCH] Old Batch Closed. New Batch Started: " + newLotId);
  } else {
    currentState = IDLE;
    remoteLog("[BATCH] Old Batch Closed. Waiting for next batch...");
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 11: BOOT RECOVERY — loadBatchStateNVS
// ════════════════════════════════════════════════════════════════════════════

void loadBatchStateNVS() {
  // Read NVS state upfront for cross-validation against RTC.
  bool          nvsValid = preferences.getBool("valid", false);
  unsigned long nvsCnt   = preferences.getULong("count", 0);
  String        nvsLot   = preferences.getString("lot", "");
  uint64_t      nvsStart = preferences.getULong64("start", 0);
  unsigned long nvsSC    = preferences.getULong("stateChg", 0);

  // ── 1. Check RTC First (Survives Crash/WDT) ──
  // FIX #13: Verify CRC to catch partial/corrupt RTC writes.
  // Cross-validate RTC lot against NVS lot — if they differ, the crash
  // happened AFTER resetBatch() cleared the lot but BEFORE initRTCState()
  // updated RTC for the new lot. Reject stale RTC and fall through to NVS.
  if (rtcState.magic == RTC_MAGIC && computeRTCCRC(rtcState) == rtcState.crc) {
    String rtcLot = String(rtcState.lotId);

    // Lot mismatch: salvage stale RTC batch as PARTIAL_RECOVERY.
    if (nvsValid && nvsLot != "" && rtcLot != nvsLot) {
      Serial.printf("[!!!] LOT SWITCH DETECTED on reboot!\n"
                    "  RTC lot (stale): %s  (%lu strokes)\n"
                    "  NVS lot (current): %s\n"
                    "  Salvaging RTC batch before switching to NVS.\n",
                    rtcLot.c_str(), rtcState.count, nvsLot.c_str());
      remoteLog("[!!!] LOT SWITCH on reboot: stale=" + rtcLot + " current=" +
                nvsLot + ". Salvaging " + String(rtcState.count) + " strokes.");

      if (rtcState.count > 0) {
        String uuid = generateUUID();
        queueBatchData(rtcLot, (long)rtcState.count, rtcState.startTime,
                       0,                    // unknown sys time
                       0,                    // invalid end — retroactive correction
                       getSystemMillis(),
                       getDeviceId(), uuid,
                       "PARTIAL_RECOVERY");
      }
      rtcState.magic = 0x00000000;
      // Fall through to NVS path below.

    } else {
      // RTC and NVS agree (or NVS has no record) — safe to use RTC.
      Serial.println("Recovered Batch from RTC Memory (Soft Reboot)!");
      remoteLog("[WARN] Reboot detected! Recovered lot " + rtcLot +
                " from RTC (" + String(rtcState.count) + " strokes).");

      safeResetStrokeCount();
      portENTER_CRITICAL(&mux);
      strokeCount = rtcState.count;
      portEXIT_CRITICAL(&mux);

      currentLotId        = rtcLot;
      lastQrContent       = String(rtcState.lastQr);
      batchStartTime      = rtcState.startTime;
      batchStartSysTime   = getSystemMillis();
      strokesAtStateChange = nvsSC;

      currentState        = MONITORING;
      lastSavedStrokeCount = strokeCount;
      restoredFromReboot  = true;
      return;
    }
  }

  // ── 2. Check NVS (Survives Power Loss) ──
  if (nvsValid && (nvsCnt > 0 || nvsLot != "")) {
    Serial.println("Recovered Batch from NVS Flash (Power Loss)!");
    remoteLog("[WARN] Power-loss reboot detected! Recovered lot " + nvsLot +
              " from NVS (" + String(nvsCnt) + " strokes).");

    safeResetStrokeCount();
    portENTER_CRITICAL(&mux);
    strokeCount = nvsCnt;
    portEXIT_CRITICAL(&mux);

    currentLotId         = nvsLot;
    batchStartTime       = nvsStart;
    batchStartSysTime    = getSystemMillis();
    strokesAtStateChange = nvsSC;

    currentState         = MONITORING;
    lastSavedStrokeCount = nvsCnt;

    // Sync back to RTC for future crashes
    initRTCState();
    rtcState.count = nvsCnt;
    // CRITICAL: initRTCState() computed CRC with count=0. Recompute now.
    rtcState.crc = computeRTCCRC(rtcState);
    restoredFromReboot = true;
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 12: WiFi & TIME SYNC
// ════════════════════════════════════════════════════════════════════════════

// --- HTTP Time Sync (bypasses corporate firewall UDP blocks) ---
// Attempts worldtimeapi.org → time.akamai.com → UDP NTP as fallback chain.
// FIX: Each attempt properly calls http.end() before the next — no resource leak.
bool syncTimeHTTP() {
  if (WiFi.status() != WL_CONNECTED) return false;

  Serial.println("[TIME] Attempting HTTP Time Sync to bypass firewall...");
  HTTPClient http;

  // Shared User-Agent: prevents public APIs from blocking generic IoT clients.
  const char *userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // --- Attempt 1: worldtimeapi.org ---
  http.begin("http://worldtimeapi.org/api/timezone/Etc/UTC");
  http.setUserAgent(userAgent);
  http.setTimeout(5000);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, payload) && doc.containsKey("unixtime")) {
      uint64_t unixtime = doc["unixtime"].as<uint64_t>();
      if (unixtime > MIN_VALID_EPOCH) {
        struct timeval tv;
        tv.tv_sec  = unixtime;
        tv.tv_usec = 0;
        settimeofday(&tv, NULL);
        setenv("TZ", "UTC-5:30", 1);
        tzset();
        Serial.println("[TIME] Synced via worldtimeapi.org");
        http.end();
        return true;
      }
    }
  }
  http.end(); // Always close before next attempt.

  // --- Attempt 2: time.akamai.com ---
  http.begin("http://time.akamai.com/");
  http.setUserAgent(userAgent);
  http.setTimeout(5000);

  httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    payload.trim();
    uint64_t unixtime = payload.toInt(); // Akamai returns raw seconds

    if (unixtime > MIN_VALID_EPOCH) {
      struct timeval tv;
      tv.tv_sec  = unixtime;
      tv.tv_usec = 0;
      settimeofday(&tv, NULL);
      setenv("TZ", "UTC-5:30", 1);
      tzset();
      Serial.println("[TIME] Synced via time.akamai.com");
      http.end();
      return true;
    }
  }
  http.end();

  // --- Fallback: Standard UDP NTP ---
  Serial.printf("[TIME] HTTP Sync Failed (code: %d). Falling back to UDP NTP...\n", httpCode);
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);
  return false;
}

// --- Time Initialization ---
void initTime() {
  Serial.println("Initializing Time Sync...");
  syncTimeHTTP();
}

// --- WiFi Manager Task (Core 0) ---
// FIX #15: Multi-AP failover with band steering mitigation.
// Runs entirely on Core 0 — never blocks the sensor loop on Core 1.
void wifiTask(void *parameter) {
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      const char *nextSsid = AP_LIST[currentApIndex].ssid;
      const char *nextPass = AP_LIST[currentApIndex].pass;

      Serial.printf("\n[WIFI MANAGER] Connecting to: %s\n", nextSsid);

      // Explicit graceful reset. Avoid disconnect(true, true) as it can
      // corrupt NVS.
      WiFi.disconnect();
      WiFi.mode(WIFI_OFF);
      vTaskDelay(100 / portTICK_PERIOD_MS);
      WiFi.mode(WIFI_STA);
      vTaskDelay(100 / portTICK_PERIOD_MS);

      // --- BAND STEERING MITIGATION ---
      // Force 2.4GHz-only protocols (b/g/n). The ESP32 is physically
      // 2.4GHz-only; this tells "Smart Connect" routers not to attempt
      // 5GHz band steering.
      WiFi.setSleep(false); // FIX #17: No power-saving for industrial stability
      esp_wifi_set_protocol(WIFI_IF_STA,
          WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);

      WiFi.begin(nextSsid, nextPass);

      // Block task for up to 15 seconds. Safe because we're on Core 0,
      // completely separate from loop() and ISR on Core 1.
      int attempts = 0;
      while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        vTaskDelay(500 / portTICK_PERIOD_MS);
        attempts++;
      }

      if (WiFi.status() != WL_CONNECTED) {
        Serial.printf("[WIFI MANAGER] Timeout on %s. Cycling to next AP...\n",
                      nextSsid);
        currentApIndex = (currentApIndex + 1) % NUM_APS;
      } else {
        Serial.printf("[WIFI MANAGER] Success! Connected to %s\n", nextSsid);
      }
    } else {
      // If connected, check status every 3 seconds.
      vTaskDelay(3000 / portTICK_PERIOD_MS);
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 13: STATE MACHINE — QR Scanner & Sensor Logic
// ════════════════════════════════════════════════════════════════════════════

void handleQrScan() {
  if (!Serial2.available()) return;

  String qrData = Serial2.readStringUntil('\n');
  qrData.trim();

  // Truncate at FIRST \r to prevent QR doubling.
  // If scanner fires twice fast (LOT001\rLOT001\n), global replace("\r","")
  // would concatenate them. Truncating at indexOf('\r') safely isolates
  // only the first scan.
  int crPos = qrData.indexOf('\r');
  if (crPos >= 0)
    qrData = qrData.substring(0, crPos);
  qrData.trim();

  // Guard: require at least 3 characters to reject UART garbage bytes.
  if (qrData.length() < 3) return;

  // FIX #2: QR Debounce — ignore same QR re-scan for QR_DEBOUNCE_MS.
  uint64_t now = getSystemMillis();
  if (qrData == lastQrContent && (now - lastQrScanTime < QR_DEBOUNCE_MS)) {
    Serial.println("Duplicate QR Scan ignored.");
    return;
  }
  lastQrContent = qrData;
  lastQrScanTime = now;

  // Audio cue for successful scan
  triggerBuzzer(true);
  delay(150);
  triggerBuzzer(false);

  remoteLog("[QR] Scanned: " + qrData);

  if (currentState == IDLE) {
    currentLotId = qrData;
    remoteLog("[STATE] Lot ID Assigned. Waiting for start.");
    saveBatchStateNVS();

  } else if (currentState == MONITORING || currentState == WAITING_FOR_NEXT_QR) {
    if (currentLotId == "" || currentLotId == "Unknown") {
      currentLotId = qrData;
      remoteLog("[STATE] Lot ID Updated mid-batch to " + qrData +
                " (strokes so far: " + String(safeGetStrokeCount()) + ")."
                " Scan same QR to close, or new QR to switch.");
      saveBatchStateNVS();
      saveBatchStateRTC();

    } else if (currentLotId == qrData) {
      // Safety: minimum batch duration prevents accidental same-QR finish
      // immediately after start. Bypassed if restored from reboot (since
      // batchStartSysTime is reset on boot, making batchAge artificially low).
      uint64_t batchAge = getSystemMillis() - batchStartSysTime;
      if (batchAge < QR_DEBOUNCE_MS && !restoredFromReboot) {
        remoteLog("[WARN] Same QR scanned too soon after batch start (" +
                  String((uint32_t)batchAge) + "ms). Ignoring.");
        return;
      }
      remoteLog("[STATE] Same QR Scanned. Ending Batch.");
      finishAndStartNewBatch("");

    } else {
      remoteLog("[STATE] New QR Scanned. Switching Batch.");
      triggerBuzzer(false);
      finishAndStartNewBatch(qrData);
    }
  }
}

void checkSensorsAndState() {
  // IR Sensor: LOW = beam broken (object present), HIGH = clear (chain passed)
  bool irChainPresent = (digitalRead(PIN_IR_SENSOR) == LOW);
  isChainEnded = !irChainPresent;

  // Debug: only log when IR state actually changes
  static bool lastIRState = false;
  if (irChainPresent != lastIRState) {
    lastIRState = irChainPresent;
  }

  uint64_t currentTime = getSystemMillis();
  uint64_t timeSinceLastStroke = currentTime - lastStrokeSystemTime;

  long currentStrokes = safeGetStrokeCount();
  // FIX #5: Relative stroke tracking since last major state change
  long newStrokes = currentStrokes - strokesAtStateChange;

  // --- NVS Save (Flash Backup) ---
  // Triggers on EITHER:
  //   1. Every 90 seconds — balanced against WiFi stability (flash writes
  //      disable SPI cache across BOTH cores for ~5-50ms, starving WiFi).
  //   2. Every 100 strokes — at 70/min that's ~86s between saves, roughly
  //      matching the time trigger so they don't fire closely together.
  static uint64_t lastNVSSaveTime = 0;
  static unsigned long lastNVSSaveStrokeCount = 0;
  unsigned long strokeDelta = (unsigned long)currentStrokes - lastNVSSaveStrokeCount;
  bool timeTrigger   = (currentState == MONITORING) && (currentTime - lastNVSSaveTime > 90000);
  bool strokeTrigger = (currentState == MONITORING) && (strokeDelta >= 100);
  if (timeTrigger || strokeTrigger) {
    saveBatchStateNVS();
    lastNVSSaveTime = currentTime;
    lastNVSSaveStrokeCount = (unsigned long)currentStrokes;
  }

  switch (currentState) {
  case IDLE:
    if (currentStrokes >= BATCH_START_STROKES) {
      remoteLog("[BATCH] " + String(BATCH_START_STROKES) +
                " strokes confirmed. Starting Batch.");

      uint64_t currentEpoch = getEpochTime();
      batchStartTime = (currentEpoch > MIN_VALID_EPOCH) ? currentEpoch : 0;
      batchStartSysTime = getSystemMillis();

      currentState = MONITORING;
      strokesAtStateChange = currentStrokes;

      initRTCState();
      saveBatchStateNVS();
      lastNVSSaveTime = currentTime;

      if (currentLotId == "")
        Serial.println("Warning: No Lot ID assigned yet.");
    }
    break;

  case MONITORING:
    // Fix loop reset bug
    if (batchStartSysTime == 0 && currentStrokes > 0) {
      batchStartTime = getEpochTime();
      batchStartSysTime = getSystemMillis();
      initRTCState();
      saveBatchStateNVS();
    }

    // Keep the RTC CRC in sync with the live stroke count.
    // The ISR updates rtcState.count but cannot safely recompute CRC.
    // This periodic check corrects drift so the next soft-reboot recovery
    // gets the right count.
    {
      unsigned long liveCount = (unsigned long)currentStrokes;
      if (rtcState.magic == RTC_MAGIC && rtcState.count != liveCount) {
        rtcState.count = liveCount;
        rtcState.crc = computeRTCCRC(rtcState);
      }
    }

    // --- Missing QR Alert ---
    // Only after 3 strokes without a QR to avoid false triggers from
    // accidental bumps.
    {
      static bool wasMissingQR = false;
      if ((currentLotId == "" || currentLotId == "Unknown") && newStrokes >= 3) {
        if ((currentTime % 500) < 250) {
          triggerBuzzer(true);
        } else {
          triggerBuzzer(false);
        }
        wasMissingQR = true;
      } else if (wasMissingQR &&
                 !(currentLotId == "" || currentLotId == "Unknown")) {
        triggerBuzzer(false);
        wasMissingQR = false;
      }
    }

    // --- Periodic live status log (every 60 seconds) ---
    {
      static uint64_t lastCountLogTime = 0;
      if (currentTime - lastCountLogTime >= 60000) {
        lastCountLogTime = currentTime;
        long batchStrokes = currentStrokes - strokesAtStateChange;
        remoteLog("[STATUS] Current batch strokes: " + String(batchStrokes) +
                  " | Lot: " + (currentLotId != "" ? currentLotId : "No QR"));
      }
    }

    // --- Chain End Detection ---
    // IR clear + silence for CHAIN_END_TIMEOUT_MS + at least 1 count.
    if (isChainEnded && timeSinceLastStroke > CHAIN_END_TIMEOUT_MS &&
        currentStrokes > 0) {
      remoteLog("[BATCH] Physical Batch End Detected (IR clear + timeout). "
                "Buzzing for QR scan...");
      currentState = WAITING_FOR_NEXT_QR;
      strokesAtStateChange = currentStrokes;
      triggerBuzzer(true);
      saveBatchStateNVS();
      lastNVSSaveTime = currentTime;
    }
    break;

  case WAITING_FOR_NEXT_QR:
    // Require BATCH_START_STROKES new strokes before returning to MONITORING.
    // A single vibration stroke is not enough to confirm a new chain.
    // Without this threshold, vibration could oscillate state back, call
    // saveBatchStateNVS() with lot="", and lose the lot ID on reboot.
    if (newStrokes >= BATCH_START_STROKES) {
      remoteLog("[BATCH] " + String(BATCH_START_STROKES) +
                " new strokes confirmed. Resuming Batch (Lot: " +
                (currentLotId != "" ? currentLotId : "No QR") + ").");
      currentState = MONITORING;
      strokesAtStateChange = currentStrokes;
      triggerBuzzer(false);
      saveBatchStateNVS();
      saveBatchStateRTC();
    }
    break;
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 14: NETWORK TASKS — Log, Upload, Heartbeat
// ════════════════════════════════════════════════════════════════════════════

// --- Non-blocking log sender (Audit Fix #12) ---
// Enqueues the message and returns immediately. The actual HTTP POST
// is handled by logTask() on Core 0.
void sendLog(const String &message) {
  if (message.length() == 0 || logQueue == NULL) return;
  LogEntry entry;
  message.substring(0, 255).toCharArray(entry.message, sizeof(entry.message));
  xQueueSend(logQueue, &entry, 0); // Drop silently if full (non-critical)
}

// --- Log Drain Task (Core 0, priority 0) ---
void logTask(void *parameter) {
  const char *devId = getDeviceId();
  LogEntry entry;

  // Persistent TLS client — avoids re-allocating SSL context every call.
  WiFiClientSecure tlsClient;
  tlsClient.setInsecure();

  for (;;) {
    if (xQueueReceive(logQueue, &entry, portMAX_DELAY) == pdTRUE) {
      if (WiFi.status() != WL_CONNECTED || getEpochTime() < MIN_VALID_EPOCH) {
        vTaskDelay(500 / portTICK_PERIOD_MS);
        continue;
      }

      // Serialize to stack buffer.
      StaticJsonDocument<256> doc;
      doc["device_id"] = devId;
      doc["message"]   = (const char *)entry.message;

      char body[300];
      size_t bodyLen = serializeJson(doc, body, sizeof(body));

      uint64_t ts = getEpochTime();
      char sig[65];
      generateSignature(body, bodyLen, ts, deviceKeyHex, sig);

      HTTPClient http;
      http.begin(tlsClient, SERVER_LOG_URL);
      http.setTimeout(3000);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("x-timestamp", String((uint32_t)ts));
      http.addHeader("x-signature", sig);
      http.POST((uint8_t *)body, bodyLen); // fire-and-forget
      http.end();
    }
  }
}

// --- Process Offline Flash Data ---
// Reads /offline.json, uploads each entry, handles failures gracefully.
// Accepts a WiFiClientSecure& for TLS reuse across items.
void processOfflineData(const char *deviceId, WiFiClientSecure &tlsClient) {
  // ── STEP 1: Atomically rename /offline.json → /processing.json ──
  if (xSemaphoreTake(offlineFileMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    Serial.println("[WARN] offlineFileMutex timeout in processOfflineData");
    return;
  }
  if (!LittleFS.exists("/offline.json")) {
    xSemaphoreGive(offlineFileMutex);
    return;
  }
  LittleFS.rename("/offline.json", "/processing.json");
  xSemaphoreGive(offlineFileMutex);
  // Mutex released: saveToOffline() can now freely create/append to a
  // fresh /offline.json without interference.

  // ── STEP 2: Process /processing.json (network calls, may take seconds) ──
  File procFile = LittleFS.open("/processing.json", FILE_READ);
  if (!procFile) {
    Serial.println("[ERR] Failed to open /processing.json for reading");
    LittleFS.remove("/processing.json");
    return;
  }

  Serial.println("Processing Offline Flash Data...");
  bool abortedForNTP = false;

  while (procFile.available()) {
    String line = procFile.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    // Audit Fix #8: Guard each item with NTP check. If NTP still isn't
    // synced, abort and defer remaining items.
    if (getEpochTime() < MIN_VALID_EPOCH) {
      Serial.println("NTP not synced mid-processOffline — deferring remaining items.");
      abortedForNTP = true;
      if (xSemaphoreTake(offlineFileMutex, pdMS_TO_TICKS(2000)) == pdTRUE) {
        File deferFile = LittleFS.open("/offline.json", FILE_APPEND);
        if (deferFile) {
          deferFile.println(line);
          while (procFile.available()) {
            String remaining = procFile.readStringUntil('\n');
            remaining.trim();
            if (remaining.length() > 0)
              deferFile.println(remaining);
          }
          deferFile.close();
        }
        xSemaphoreGive(offlineFileMutex);
      }
      break;
    }

    // Parse and enrich
    StaticJsonDocument<512> doc;
    DeserializationError deErr = deserializeJson(doc, line);
    if (deErr) {
      Serial.printf("Skipping corrupted flash entry: %s\n", deErr.c_str());
      continue;
    }

    if (!doc.containsKey("device_id"))
      doc["device_id"] = deviceId;

    // --- Retroactive Timestamp Calculation ---
    // If this batch was flushed to flash while offline, start_time is
    // likely 0/1970. Calculate real timestamps now that NTP is synced.
    uint64_t startT = doc["start_time"].as<uint64_t>();
    if (startT < MIN_VALID_EPOCH) {
      uint64_t curEpo = getEpochTime();
      if (doc.containsKey("start_sys_time")) {
        uint64_t sst    = doc["start_sys_time"].as<uint64_t>();
        uint64_t eat    = doc["end_sys_time"].as<uint64_t>();
        uint64_t curSys = getSystemMillis();
        if (curSys > sst) {
          doc["start_time"] = curEpo - ((curSys - sst) / 1000);
          doc["end_time"]   = curEpo - ((curSys - eat) / 1000);
          Serial.println("Flash Batch Retroactively Corrected (Offset Sync)!");
        } else {
          doc["start_time"] = curEpo - 10;
          doc["end_time"]   = curEpo;
          Serial.println("Flash Batch Reboot Sync: Fallback Timestamp Used.");
        }
      } else {
        doc["start_time"] = curEpo - 10;
        doc["end_time"]   = curEpo;
        Serial.println("Flash Batch Legacy Sync: Fallback Timestamp Used.");
      }
    }

    // Remove temporary internal fields before sending to server
    doc.remove("start_sys_time");
    doc.remove("end_sys_time");

    // Safety: server requires end_time > start_time
    if (doc["end_time"].as<uint64_t>() <= doc["start_time"].as<uint64_t>()) {
      doc["end_time"] = doc["start_time"].as<uint64_t>() + 1;
    }

    // Serialize to stack buffer
    char body[512];
    size_t bodyLen = serializeJson(doc, body, sizeof(body));

    uint64_t nowHeader = getEpochTime();
    char sig[65];
    generateSignature(body, bodyLen, nowHeader, deviceKeyHex, sig);

    HTTPClient http;
    http.begin(tlsClient, SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-timestamp", String((unsigned long)nowHeader));
    http.addHeader("x-signature", sig);

    int httpResponseCode = http.POST((uint8_t *)body, bodyLen);
    lastUploadHttpCode = httpResponseCode;

    if (httpResponseCode == 200 || httpResponseCode == 201) {
      Serial.println("Offline Item Uploaded");
    } else {
      String responseStr = http.getString();
      Serial.printf("Offline Upload Failed (%d): %s. Keeping.\n",
                    httpResponseCode, responseStr.c_str());
      if (xSemaphoreTake(offlineFileMutex, pdMS_TO_TICKS(2000)) == pdTRUE) {
        File failFile = LittleFS.open("/offline.json", FILE_APPEND);
        if (failFile) {
          failFile.println(body);
          failFile.close();
        }
        xSemaphoreGive(offlineFileMutex);
      }
    }
    http.end();
    vTaskDelay(10 / portTICK_PERIOD_MS);
  }

  procFile.close();

  // ── STEP 3: Clean up ──
  // NEVER delete /offline.json here — new data may have been written
  // by saveToOffline() on Core 1 during processing.
  LittleFS.remove("/processing.json");

  if (!abortedForNTP && lastUploadHttpCode >= 200 && lastUploadHttpCode < 300) {
    lastUploadHttpCode = 200;
  }
  Serial.println("Offline processing complete.");
}

// --- Background Upload Task (Core 0) (FIX #3, #10) ---
void uploadTask(void *parameter) {
  // Do NOT register with Task WDT. http.POST() blocks for seconds,
  // which would trigger a watchdog crash.

  const char *deviceId = getDeviceId();
  std::deque<BatchData> ramBuffer;
  uint64_t wifiDownSince = 0;

  // Persistent TLS client — avoids re-allocating SSL context per request.
  WiFiClientSecure tlsClient;
  tlsClient.setInsecure();

  for (;;) {
    // 1. Drain Queue into RAM Buffer
    BatchData data;
    while (xQueueReceive(uploadQueue, &data, 0) == pdTRUE) {
      if (ramBuffer.size() < MAX_RAM_BUFFER_SIZE) {
        ramBuffer.push_back(data);
      } else {
        Serial.println("RAM Buffer Full! Moving oldest to Flash.");
        saveToOffline(ramBuffer.front());
        ramBuffer.pop_front();
        ramBuffer.push_back(data);
      }
    }

    // 2. Process RAM Buffer
    if (!ramBuffer.empty()) {
      if (WiFi.status() == WL_CONNECTED) {
        // Wait for NTP before uploading — 1970 timestamps cause 403.
        uint64_t currentEpoch = getEpochTime();
        if (currentEpoch < MIN_VALID_EPOCH) {
          Serial.println("WiFi connected, but waiting for NTP time sync...");
          vTaskDelay(2000 / portTICK_PERIOD_MS);
          continue;
        }

        BatchData &current = ramBuffer.front();

        // FIX #1: Retroactive Timestamp Correction
        if (current.startTime < MIN_VALID_EPOCH) {
          uint64_t durationMS = getSystemMillis() - current.startSysTime;
          current.startTime = currentEpoch - (durationMS / 1000);
          Serial.println("Retroactively Corrected Start Time!");
        }
        if (current.endTime < MIN_VALID_EPOCH) {
          uint64_t durationMS = getSystemMillis() - current.endSysTime;
          current.endTime = currentEpoch - (durationMS / 1000);
          Serial.println("Retroactively Corrected End Time!");
        }

        // Server requires end_time > start_time
        if (current.endTime <= current.startTime) {
          current.endTime = current.startTime + 1;
        }

        // Serialize to stack buffer
        StaticJsonDocument<512> doc;
        doc["start_time"]     = current.startTime;
        doc["end_time"]       = current.endTime;
        doc["duration"]       = current.duration;
        doc["lot_id"]         = current.lotId;
        doc["units_produced"] = current.unitsProduced;
        doc["device_id"]      = deviceId;
        doc["batch_uuid"]     = current.batch_uuid;
        if (current.notes[0] != '\0')
          doc["notes"] = current.notes;

        char body[512];
        size_t bodyLen = serializeJson(doc, body, sizeof(body));

        uint64_t nowHeader = getEpochTime();
        char sig[65];
        generateSignature(body, bodyLen, nowHeader, deviceKeyHex, sig);

        HTTPClient http;
        http.begin(tlsClient, SERVER_URL);
        http.setTimeout(4000);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("x-signature", sig);
        http.addHeader("x-timestamp", String((unsigned long)nowHeader));

        int httpResponseCode = http.POST((uint8_t *)body, bodyLen);
        lastUploadHttpCode = httpResponseCode;

        if (httpResponseCode >= 200 && httpResponseCode < 300) {
          http.end();
          Serial.printf("Uploaded! Response: %d\n", httpResponseCode);
          ramBuffer.pop_front();
        } else if (httpResponseCode > 0) {
          String responseStr = http.getString();
          http.end();
          Serial.printf("Server Error %d: %s \nSaving to flash and retrying in 5s...\n",
                        httpResponseCode, responseStr.c_str());
          saveToOffline(ramBuffer.front());
          ramBuffer.pop_front();
          vTaskDelay(5000 / portTICK_PERIOD_MS);
        } else {
          http.end();
          Serial.printf("Network Error (code %d). Retrying in 2s...\n",
                        httpResponseCode);
          vTaskDelay(2000 / portTICK_PERIOD_MS);
        }
      } else {
        // WiFi Down: data safe in RAM. If down > 2 min, flush to flash.
        if (wifiDownSince == 0) wifiDownSince = getSystemMillis();

        if ((getSystemMillis() - wifiDownSince) > 120000 && !ramBuffer.empty()) {
          Serial.println("WiFi down >2min. Flushing oldest batch to flash.");
          saveToOffline(ramBuffer.front());
          ramBuffer.pop_front();
          wifiDownSince = getSystemMillis();
        }
        vTaskDelay(1000 / portTICK_PERIOD_MS);
      }
    } else {
      // RAM buffer empty: check flash for offline data
      if (WiFi.status() == WL_CONNECTED) {
        wifiDownSince = 0;
        if (getEpochTime() > MIN_VALID_EPOCH) {
          processOfflineData(deviceId, tlsClient);
        }
      }
      vTaskDelay(100 / portTICK_PERIOD_MS);
    }
  }
}

// --- Heartbeat Sender ---
// Sends device status, fetches IT commands. Uses ArduinoJson serialization
// instead of manual String concatenation to eliminate ~15 temporary heap
// allocations per call.
void sendHeartbeat(WiFiClientSecure &tlsClient) {
  const char *devId = getDeviceId();
  uint64_t ts = getEpochTime();

  // Guard: don't send if NTP hasn't synced — server will reject with 403.
  if (ts < MIN_VALID_EPOCH) {
    Serial.println("[HEARTBEAT] Skipping — NTP not yet synced.");
    return;
  }

  // Build status strings on the stack — no heap allocation.
  char status[40]  = "Running Normally";
  char errMsg[50]  = "";
  char errSol[50]  = "";

  if (lastUploadHttpCode > 0 && lastUploadHttpCode != 200 &&
      lastUploadHttpCode != 201) {
    snprintf(status, sizeof(status), "Upload Error (%d)", lastUploadHttpCode);
    strncpy(errMsg, "Server API returning error.", sizeof(errMsg) - 1);
    strncpy(errSol, "Check server logs or schema.", sizeof(errSol) - 1);
  } else if (lastUploadHttpCode < 0) {
    snprintf(status, sizeof(status), "Network Error (%d)", lastUploadHttpCode);
    strncpy(errMsg, "Unable to reach server API.", sizeof(errMsg) - 1);
    strncpy(errSol, "Check internet connection or server uptime.", sizeof(errSol) - 1);
  }

  // Calculate real idle time
  uint64_t nowSys = getSystemMillis();
  uint64_t copyLastStroke = lastStrokeSystemTime;
  uint64_t latestActivity = max(copyLastStroke, lastQrScanTime);
  long idleTimeSec = (long)((nowSys - latestActivity) / 1000ULL);

  // FIX #14: Snapshot pools before sending, clear on success
  uint32_t snapActive = activeSecsPool;
  uint32_t snapIdle   = idleSecsPool;

  // Live batch progress for the remote panel
  long currentBatchStrokes =
      (currentState == MONITORING || currentState == WAITING_FOR_NEXT_QR)
          ? (long)(safeGetStrokeCount() - strokesAtStateChange)
          : 0;

  // --- Build JSON body with ArduinoJson (stack-allocated) ---
  // Key insertion order matches the original manual concat for consistency.
  StaticJsonDocument<384> doc;
  doc["device_id"]       = devId;
  doc["status"]          = status;
  doc["error_msg"]       = errMsg;
  doc["error_solution"]  = errSol;
  doc["idle_time"]       = idleTimeSec;
  doc["active_secs"]     = snapActive;
  doc["idle_secs"]       = snapIdle;
  doc["current_strokes"] = currentBatchStrokes;
  doc["batch_lot"]       = (currentLotId.length() > 0) ? currentLotId.c_str() : "Idle";

  char body[384];
  size_t bodyLen = serializeJson(doc, body, sizeof(body));

  char sig[65];
  generateSignature(body, bodyLen, ts, deviceKeyHex, sig);

  HTTPClient http;
  http.begin(tlsClient, SERVER_HEARTBEAT_URL);
  http.setTimeout(6000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-timestamp", String((unsigned long)ts));
  http.addHeader("x-signature", sig);

  int code = http.POST((uint8_t *)body, bodyLen);
  if (code != 200) {
    Serial.printf("[HEARTBEAT ERROR] HTTP Code: %d\n", code);
    if (code > 0) {
      String errResp = http.getString();
      Serial.println("[HEARTBEAT ERROR] Server Response: " + errResp);
    }
    http.end();
    return;
  }

  // Success — clear the pools
  activeSecsPool -= snapActive;
  idleSecsPool   -= snapIdle;

  String resp = http.getString();
  http.end();

  // Parse commands: { "commands": [ { "cmd": "RESTART", ... }, ... ] }
  StaticJsonDocument<512> respDoc;
  DeserializationError jsonErr = deserializeJson(respDoc, resp);
  if (jsonErr) {
    remoteLog("[HEARTBEAT ERROR] JSON Parse Fail: " + String(jsonErr.c_str()));
    return;
  }
  JsonArray cmds = respDoc["commands"].as<JsonArray>();
  if (cmds.isNull() || cmds.size() == 0) return;

  for (JsonObject c : cmds) {
    String cmd = c["cmd"].as<String>();
    Serial.println("[REMOTE CMD] " + cmd);
    remoteLog("[REMOTE CMD] Received: " + cmd);

    if (cmd == "RESTART") {
      remoteLog("[RESTART] Rebooting in 1 second by IT command...");
      clearBatchStateNVS();
      delay(1000);
      ESP.restart();

    } else if (cmd == "CLEAR_FLAGS") {
      clearBatchStateNVS();
      currentState = IDLE;
      safeResetStrokeCount();
      strokesAtStateChange = 0;
      currentLotId         = "";
      batchStartTime       = 0;
      batchStartSysTime    = 0;
      triggerBuzzer(false);
      lastUploadHttpCode   = 200;
      remoteLog("[CLEAR_FLAGS] Error flags and batch state cleared.");

    } else if (cmd == "FORCE_SYNC") {
      if (WiFi.status() == WL_CONNECTED) {
        remoteLog("[FORCE_SYNC] Flushing offline flash data...");
        processOfflineData(devId, tlsClient);
        remoteLog("[FORCE_SYNC] Done.");
      } else {
        remoteLog("[FORCE_SYNC] WiFi not connected, skipping.");
      }
    }
  }
}

// --- Heartbeat Task (Core 0) ---
// Isolated from loop() so HTTP blocking never starves WiFi.
void heartbeatTask(void *parameter) {
  uint8_t ntpRetries = 0;

  // Persistent TLS client — reused across all heartbeat + FORCE_SYNC calls.
  WiFiClientSecure tlsClient;
  tlsClient.setInsecure();

  for (;;) {
    vTaskDelay(5000 / portTICK_PERIOD_MS);

    if (WiFi.status() == WL_CONNECTED) {
      // Back off if upload queue has pending batches — give uploadTask
      // exclusive radio access during HTTPS handshake. Simultaneous
      // HTTPS from heartbeat + upload = -1 errors on both.
      UBaseType_t queuedBatches = uxQueueMessagesWaiting(uploadQueue);
      if (queuedBatches > 0) {
        Serial.printf("[HEARTBEAT SKIP] %u batch(es) uploading — yielding radio.\n",
                      (unsigned)queuedBatches);
        vTaskDelay(5000 / portTICK_PERIOD_MS);
        continue;
      }

      // If NTP still not synced after 3 attempts (15s), force retry
      if (getEpochTime() < MIN_VALID_EPOCH) {
        ntpRetries++;
        if (ntpRetries >= 3) {
          ntpRetries = 0;
          Serial.println("[TIME] Clock not synced. Retrying...");
          syncTimeHTTP();
        }
      } else {
        ntpRetries = 0;
        sendHeartbeat(tlsClient);
      }
    }
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  SECTION 15: SETUP & LOOP
// ════════════════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);

  // --- QR Scanner UART (one-time init) ---
  // FIX #16: 50ms timeout prevents 1-second blocking on readStringUntil.
  Serial2.begin(9600, SERIAL_8N1, PIN_QR_RX, PIN_QR_TX);
  Serial2.setTimeout(50);

  // --- GPIO ---
  pinMode(PIN_PROXIMITY, INPUT_PULLUP);
  // IR sensor: INPUT_PULLUP so pin reads HIGH when floating/disconnected.
  // Most 3-pin IR sensors pull LOW on detect (NPN open-collector).
  pinMode(PIN_IR_SENSOR, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  // --- Buzzer PWM Setup (one-time) ---
  // Configure the PWM timer ONCE here. triggerBuzzer() only toggles
  // duty cycle via ledcWrite() — no repeated ledcAttach() hardware reconfig.
  ledcAttach(PIN_BUZZER, 2000, 8); // 2kHz, 8-bit resolution

  // --- Buzzer Self-Test ---
  Serial.println("Buzzer self-test...");
  ledcWrite(PIN_BUZZER, 128);
  delay(300);
  ledcWrite(PIN_BUZZER, 0);
  Serial.println("Buzzer test done.");

  // --- Interrupt ---
  attachInterrupt(digitalPinToInterrupt(PIN_PROXIMITY), onStrokeDetected, FALLING);

  // --- Filesystem & Persistence ---
  initFileSystem();
  preferences.begin("batch", false);
  loadBatchStateNVS();

  // --- WiFi ---
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // FIX #17: No power-saving for industrial stability
  delay(200);           // Let radio stabilize

#ifdef DEBUG_WIFI_SCAN
  // DIAGNOSTIC: Scan for visible SSIDs at boot (adds 3-6s)
  Serial.println("Scanning for visible WiFi networks...");
  int n = WiFi.scanNetworks();
  if (n == 0) {
    Serial.println("No networks found. Check antenna/power.");
  } else {
    Serial.printf("%d networks found:\n", n);
    for (int i = 0; i < n; ++i) {
      Serial.printf("%d: %s (%d) %s\n", i + 1, WiFi.SSID(i).c_str(),
                    WiFi.RSSI(i),
                    (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? " " : "*");
    }
  }
#endif

  WiFi.setAutoReconnect(false); // Manual failover via wifiTask
  Serial.println("Starting Dedicated WiFi Task (Core 0)...");
  initTime();
  derivePerDeviceKey();

  // --- FreeRTOS Resources ---
  uploadQueue = xQueueCreate(50, sizeof(BatchData)); // FIX #10: 50-slot burst buffer
  if (uploadQueue == NULL)
    Serial.println("Error creating upload queue");

  offlineFileMutex = xSemaphoreCreateMutex();
  if (offlineFileMutex == NULL)
    Serial.println("Error creating offline file mutex");

  logQueue = xQueueCreate(32, sizeof(LogEntry)); // Audit Fix #12: 32-entry log queue
  if (logQueue == NULL)
    Serial.println("Error creating log queue");

  // --- Background Tasks (all on Core 0) ---
  xTaskCreatePinnedToCore(uploadTask,    "UploadTask",    10000, NULL, 1, NULL, 0);
  xTaskCreatePinnedToCore(wifiTask,      "WiFiTask",      4000,  NULL, 1, NULL, 0);
  xTaskCreatePinnedToCore(logTask,       "LogTask",       6000,  NULL, 0, NULL, 0);
  xTaskCreatePinnedToCore(heartbeatTask, "HeartbeatTask", 8000,  NULL, 0, NULL, 0);

  Serial.println("System Initialized.");
  remoteLog("[BOOT] System Initialized. Device: " + String(getDeviceId()));

  // Initialize BEFORE interrupt starts firing to prevent spurious
  // chain-end timeouts on the very first loop iteration.
  lastStrokeSystemTime = getSystemMillis();
}

void loop() {
  uint64_t currentSysTime = getSystemMillis();

  // --- WiFi Status Monitoring ---
  // The actual connection logic runs in wifiTask on Core 0.
  // loop() only monitors status changes for logging and NTP triggering.
  static wl_status_t lastReportedStatus = WL_NO_SHIELD;
  static String lastReportedSSID = "";
  static uint64_t lastStatusChangeTime = 0;

  wl_status_t currentStatus = WiFi.status();
  String currentSSID = (currentStatus == WL_CONNECTED) ? WiFi.SSID() : "";

  if (currentStatus != lastReportedStatus ||
      (currentStatus == WL_CONNECTED && currentSSID != lastReportedSSID)) {
    // Wait 500ms for stability before logging (prevents spam during
    // rapid transitions).
    if (currentSysTime - lastStatusChangeTime > 500) {
      lastReportedStatus = currentStatus;
      lastReportedSSID   = currentSSID;
      lastStatusChangeTime = currentSysTime;

      Serial.print("WiFi Status: ");
      Serial.print(currentStatus);
      if (currentStatus == WL_CONNECTED) {
        Serial.print(" (Connected to ");
        Serial.print(currentSSID);
        Serial.println(")");
        Serial.print("IP: ");
        Serial.println(WiFi.localIP());
        remoteLog("[WIFI] Connected to " + currentSSID +
                  " (IP: " + WiFi.localIP().toString() + ")");
        syncTimeHTTP();
      } else {
        Serial.println(" (Disconnected/Searching)");
      }
    }
  } else {
    lastStatusChangeTime = currentSysTime; // Reset timer while stable
  }

  // --- Core Logic ---
  handleQrScan();
  checkSensorsAndState();

  // --- FIX #14: Per-second active/idle tracking ---
  if (currentSysTime - lastSecondTick >= 1000) {
    lastSecondTick = currentSysTime;
    if (currentState == MONITORING)
      activeSecsPool++;
    else
      idleSecsPool++;
  }

  delay(10);
}
