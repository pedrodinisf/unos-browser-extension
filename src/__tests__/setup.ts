/**
 * Vitest setup file - mocks Chrome extension APIs
 */
import { vi, beforeEach } from 'vitest';

// Mock chrome.runtime.sendMessage
const mockSendMessage = vi.fn();

// Mock chrome.runtime.sendNativeMessage
const mockSendNativeMessage = vi.fn();

// Mock chrome.runtime
const mockRuntime = {
  sendMessage: mockSendMessage,
  sendNativeMessage: mockSendNativeMessage,
  lastError: null as chrome.runtime.LastError | null,
  onMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
};

// Mock chrome.storage.local
const localStorageData: Record<string, unknown> = {};
const mockStorageLocal = {
  get: vi.fn((keys?: string | string[] | Record<string, unknown>) => {
    if (keys === undefined) return Promise.resolve({ ...localStorageData });
    if (typeof keys === 'string') {
      return Promise.resolve({ [keys]: localStorageData[keys] });
    }
    if (Array.isArray(keys)) {
      const result: Record<string, unknown> = {};
      keys.forEach(k => { result[k] = localStorageData[k]; });
      return Promise.resolve(result);
    }
    return Promise.resolve({ ...localStorageData, ...keys });
  }),
  set: vi.fn((items: Record<string, unknown>) => {
    Object.assign(localStorageData, items);
    return Promise.resolve();
  }),
  remove: vi.fn((keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    list.forEach(k => delete localStorageData[k]);
    return Promise.resolve();
  }),
};

// Mock chrome.cookies
const mockCookies = {
  getAll: vi.fn((_query?: unknown) => Promise.resolve([] as chrome.cookies.Cookie[])),
};

// Mock chrome.storage.session
const sessionStorage: Record<string, unknown> = {};
const mockStorageSession = {
  get: vi.fn((keys: string | string[]) => {
    if (typeof keys === 'string') {
      return Promise.resolve({ [keys]: sessionStorage[keys] });
    }
    const result: Record<string, unknown> = {};
    keys.forEach(k => { result[k] = sessionStorage[k]; });
    return Promise.resolve(result);
  }),
  set: vi.fn((items: Record<string, unknown>) => {
    Object.assign(sessionStorage, items);
    return Promise.resolve();
  }),
};

// Mock chrome.tabs
const mockTabs = {
  update: vi.fn(() => Promise.resolve({})),
  remove: vi.fn(() => Promise.resolve()),
  move: vi.fn(() => Promise.resolve({})),
  query: vi.fn(() => Promise.resolve([])),
  get: vi.fn(() => Promise.resolve({})),
};

// Mock chrome.windows
const mockWindows = {
  update: vi.fn(() => Promise.resolve({})),
  get: vi.fn(() => Promise.resolve({})),
  getAll: vi.fn(() => Promise.resolve([])),
};

// Mock chrome.alarms
const mockAlarms = {
  create: vi.fn(),
  clear: vi.fn(),
  onAlarm: {
    addListener: vi.fn(),
  },
};

// Global chrome mock
const chromeMock = {
  runtime: mockRuntime,
  storage: {
    session: mockStorageSession,
    local: mockStorageLocal,
  },
  tabs: mockTabs,
  windows: mockWindows,
  alarms: mockAlarms,
  cookies: mockCookies,
};

// Assign to global
(globalThis as unknown as { chrome: typeof chromeMock }).chrome = chromeMock;

// Export for test access
export {
  mockSendMessage,
  mockSendNativeMessage,
  mockRuntime,
  mockStorageSession,
  mockStorageLocal,
  mockTabs,
  mockWindows,
  mockCookies,
  sessionStorage,
  localStorageData,
};

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(sessionStorage).forEach(key => delete sessionStorage[key]);
  Object.keys(localStorageData).forEach(key => delete localStorageData[key]);
});
