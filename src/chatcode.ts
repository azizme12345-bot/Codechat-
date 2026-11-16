import { runStaticChecks, type ZipCheckResult } from './zipChecks.ts';

type PageTab = 'home' | 'chat' | 'code' | 'tools' | 'pricing' | 'about' | 'help';
type CodeTab = 'html' | 'css' | 'js';
type BillingMode = 'monthly' | 'yearly';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface ChatMessageTurn {
  role: 'user' | 'model';
  text: string;
}

interface AttachedTextFile {
  name: string;
  size: number;
  content: string;
}

interface ExtractedProjectFile {
  path: string;
  content: string;
  truncated: boolean;
}

interface ProjectSummary {
  name: string;
  files: string[];
  allPaths: string[];
  notSent: string[];
  checks: ZipCheckResult[];
  important: string[];
  extracted: ExtractedProjectFile[];
  total: number;
  skipped: number;
}

interface JSZipEntryLike {
  name: string;
  dir: boolean;
  async: (type: 'string') => Promise<string>;
  _data?: {
    uncompressedSize?: number;
  };
}

interface JSZipInstanceLike {
  files: Record<string, JSZipEntryLike>;
}

interface JSZipStaticLike {
  loadAsync: (file: File, options?: { checkCRC32?: boolean }) => Promise<JSZipInstanceLike>;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    JSZip?: JSZipStaticLike;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const MAX_CHAT_TEXT_FILE_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_ZIP_FILE_BYTES = 3 * 1024 * 1024; // 3 MB compressed archive limit
const MAX_ZIP_ENTRIES = 5000;
const MAX_SINGLE_UNCOMPRESSED_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_TOTAL_UNCOMPRESSED_BYTES = 40 * 1024 * 1024; // 40 MB extracted total
const MAX_ZIP_CHARS_PER_FILE = 400000; // 400,000 characters per file
const MAX_ZIP_TOTAL_UTF8_BYTES = 2400000; // 2,400,000 UTF-8 bytes total
const MAX_VISIBLE_ZIP_PATHS = 1000;

const CHATCODE_SYSTEM_INSTRUCTION =
  'You are ChatCode, a helpful, concise senior software engineer and coding assistant. Follow the Chat -> Plan -> Code workflow. When providing code, use fenced Markdown code blocks with the language tag (```html, ```css, ```javascript, etc.) so users can copy or send code directly to the workspace.';

const CHATCODE_IGNORE = /(^|\/)(node_modules|dist|build|\.git)(\/|$)/i;
const CHATCODE_IMPORTANT =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|vite\.config\.[^/]+|next\.config\.[^/]+|tsconfig\.json|jsconfig\.json|README[^/]*|index\.html|\.env\.example|wrangler\.toml|vercel\.json)$/i;
const LOCK_FILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const ALLOWED_DOTFILES = new Set(['.env.example', '.gitignore', '.gitattributes', '.nvmrc']);
const TEXT_FILE_EXT_RE =
  /\.(txt|md|markdown|html|htm|css|scss|less|js|mjs|cjs|ts|tsx|jsx|json|xml|svg|csv|yml|yaml|toml|ini|conf|py|java|c|cpp|h|hpp|cs|php|rb|go|rs|sh|bash|zsh|sql|gitignore|gitattributes|nvmrc|env\.example)$/i;
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff|woff2?|ttf|eot|otf|mp3|mp4|wav|ogg|webm|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|bin|wasm|map)$/i;

let currentTab: PageTab = 'home';
let activeCodeTab: CodeTab = 'html';
let billingMode: BillingMode = 'monthly';
let isVoiceActive = false;
let isAiLoading = false;
let attachedTextFile: AttachedTextFile | null = null;
let speechRecognition: SpeechRecognitionLike | null = null;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let toastTimer: number | null = null;
let chatConversation: ChatMessageTurn[] = [];

let chatCodeProject: ProjectSummary = {
  name: '',
  files: [],
  allPaths: [],
  notSent: [],
  checks: [],
  important: [],
  extracted: [],
  total: 0,
  skipped: 0,
};

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showToast(message: string): void {
  const toast = byId<HTMLDivElement>('toast');
  const toastMsg = byId<HTMLSpanElement>('toastMsg');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = message;
  toast.classList.remove('opacity-0', 'pointer-events-none');
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toast.classList.add('opacity-0', 'pointer-events-none');
  }, 3000);
}

function fallbackCopy(text: string): boolean {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', 'true');
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.select();
  let success = false;
  try {
    success = document.execCommand('copy');
  } catch {
    success = false;
  }
  document.body.removeChild(el);
  return success;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard!');
      return;
    } catch {
      // Fall back to execCommand below
    }
  }
  if (fallbackCopy(text)) {
    showToast('Copied to clipboard!');
  } else {
    showToast('Could not copy to clipboard.');
  }
}

// ==========================================
// GEMINI SERVER ENDPOINT CLIENT (/api/gemini)
// ==========================================
async function callGeminiApi(payload: {
  messages?: ChatMessageTurn[];
  prompt?: string;
  systemInstruction?: string;
}): Promise<string> {
  const response = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;

  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }

  if (!data || typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error(data?.error || 'Gemini returned an empty response.');
  }

  return data.text;
}

// ==========================================
// NAVIGATION
// ==========================================
function switchTab(tabId: PageTab): void {
  currentTab = tabId;

  document.querySelectorAll<HTMLElement>('.page-view').forEach((page) => {
    page.classList.add('hidden');
  });

  const targetPage = byId<HTMLElement>(`page-${tabId}`);
  if (targetPage) {
    targetPage.classList.remove('hidden');
  }

  document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
    btn.classList.remove('text-brand-blue', 'bg-white', 'shadow-sm', 'font-semibold');
    btn.classList.add('text-slate-600', 'font-medium');
  });

  const activeBtn = byId<HTMLElement>(`nav-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.remove('text-slate-600', 'font-medium');
    activeBtn.classList.add('text-brand-blue', 'bg-white', 'shadow-sm', 'font-semibold');
  }

  document.querySelectorAll<HTMLElement>('.mobile-nav-item').forEach((item) => {
    const itemTab = item.dataset.mobileNav;
    if (itemTab === tabId) {
      item.classList.add('text-brand-blue');
    } else {
      item.classList.remove('text-brand-blue');
    }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabId === 'code') {
    updateLineNumbers();
    window.setTimeout(runCodePreview, 50);
  }
}

// ==========================================
// MODALS
// ==========================================
function openDemoModal(): void {
  byId<HTMLElement>('demoModal')?.classList.remove('hidden');
}

function closeDemoModal(): void {
  byId<HTMLElement>('demoModal')?.classList.add('hidden');
}

function toggleSearchModal(): void {
  const modal = byId<HTMLElement>('searchModal');
  if (!modal) return;
  const willOpen = modal.classList.contains('hidden');
  modal.classList.toggle('hidden');
  if (willOpen) {
    const input = byId<HTMLInputElement>('globalSearchInput');
    if (input) {
      input.focus();
      handleSearchQuery(input.value);
    }
  }
}

function renderDefaultSearchResults(container: HTMLElement): void {
  const items: Array<{ tab: PageTab; label: string }> = [
    { tab: 'tools', label: '🔧 Developer Tools (JSON, Color Picker)' },
    { tab: 'pricing', label: '💳 Pricing Plans (Free vs Pro)' },
    { tab: 'help', label: '❓ Frequently Asked Questions' },
  ];

  container.replaceChildren();
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'p-2 hover:bg-slate-50 rounded-lg cursor-pointer';
    row.textContent = item.label;
    row.addEventListener('click', () => {
      toggleSearchModal();
      switchTab(item.tab);
    });
    container.appendChild(row);
  });
}

function handleSearchQuery(query: string): void {
  const results = byId<HTMLElement>('searchResults');
  if (!results) return;

  const trimmed = query.trim();
  if (!trimmed) {
    renderDefaultSearchResults(results);
    return;
  }

  const lower = trimmed.toLowerCase();
  const searchable: Array<{ tab: PageTab; label: string; keywords: string }> = [
    { tab: 'chat', label: '💬 AI Chat Assistant & Project Analyzer', keywords: 'chat ai assistant prompt zip review gemini' },
    { tab: 'code', label: '💻 Live Code Workspace (HTML, CSS, JS)', keywords: 'code editor html css js preview sandbox' },
    { tab: 'tools', label: '🔧 Developer Tools (JSON, Color, Case, URL, Word, Base64)', keywords: 'tools json formatter color picker case url word counter base64' },
    { tab: 'pricing', label: '💳 Pricing Plans (Free, Pro, Team)', keywords: 'pricing plans free pro team billing monthly yearly' },
    { tab: 'about', label: 'ℹ️ About ChatCode', keywords: 'about mission developers platform' },
    { tab: 'help', label: '❓ Help & Frequently Asked Questions', keywords: 'help faq support contact privacy terms pwa' },
  ];

  const matches = searchable.filter(
    (entry) => entry.label.toLowerCase().includes(lower) || entry.keywords.includes(lower)
  );

  results.replaceChildren();
  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'p-2 text-slate-500';
    empty.textContent = `No matching sections found for "${trimmed}".`;
    results.appendChild(empty);
    return;
  }

  matches.forEach((match) => {
    const row = document.createElement('div');
    row.className = 'p-2 hover:bg-slate-50 rounded-lg cursor-pointer';
    row.textContent = match.label;
    row.addEventListener('click', () => {
      toggleSearchModal();
      switchTab(match.tab);
    });
    results.appendChild(row);
  });
}

function openPaymentModal(plan: string): void {
  const titleEl = byId<HTMLElement>('paymentPlanTitle');
  if (titleEl) {
    const isYearly = billingMode === 'yearly';
    const price =
      plan === 'Pro Plan' ? (isYearly ? '$7.99/mo (yearly)' : '$9.99/mo') : isYearly ? '$23.99/mo (yearly)' : '$29.99/mo';
    titleEl.textContent = `${plan} (${price})`;
  }
  byId<HTMLElement>('paymentModal')?.classList.remove('hidden');
}

function closePaymentModal(): void {
  byId<HTMLElement>('paymentModal')?.classList.add('hidden');
}

function confirmPaymentInterest(): void {
  closePaymentModal();
  showToast('Thank you! You are on the early-access list.');
}

function closeAllModals(): void {
  closeDemoModal();
  byId<HTMLElement>('searchModal')?.classList.add('hidden');
  closePaymentModal();
}

// ==========================================
// AI CHAT FUNCTIONS
// ==========================================
function sendQuickPrompt(promptText: string): void {
  const chatInput = byId<HTMLInputElement>('chatInput');
  if (!chatInput) return;
  chatInput.value = promptText;
  void submitChatMessage();
}

function isSupportedTextFile(file: File): boolean {
  if (file.type && (file.type.startsWith('text/') || file.type === 'application/json' || file.type === 'application/javascript' || file.type === 'application/xml' || file.type === 'image/svg+xml')) {
    return true;
  }
  return TEXT_FILE_EXT_RE.test(file.name);
}

async function handleFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const statusEl = byId<HTMLElement>('fileStatus');

  if (file.size > MAX_CHAT_TEXT_FILE_BYTES) {
    attachedTextFile = null;
    input.value = '';
    if (statusEl) statusEl.textContent = 'File exceeds 3 MB limit.';
    showToast('Text file must be 3 MB or smaller.');
    return;
  }

  if (!isSupportedTextFile(file)) {
    attachedTextFile = null;
    input.value = '';
    if (statusEl) statusEl.textContent = 'Only plain text or code files are supported.';
    showToast('Please attach a plain text or code file.');
    return;
  }

  try {
    const content = await file.text();
    if (content.includes('\0')) {
      attachedTextFile = null;
      input.value = '';
      if (statusEl) statusEl.textContent = 'Binary files are not supported.';
      showToast('Binary files cannot be attached.');
      return;
    }

    attachedTextFile = {
      name: file.name,
      size: file.size,
      content,
    };
    const sizeKb = Math.max(1, Math.round(file.size / 1024));
    if (statusEl) {
      statusEl.textContent = `Attached: ${file.name} (${sizeKb} KB)`;
    }
    showToast(`File attached: ${file.name}`);
  } catch {
    attachedTextFile = null;
    input.value = '';
    showToast('Could not read the selected file.');
  }
}

function setMicVisual(active: boolean): void {
  isVoiceActive = active;
  const micBtn = byId<HTMLElement>('micBtn');
  if (!micBtn) return;
  if (active) {
    micBtn.classList.add('text-brand-orange', 'animate-pulse');
  } else {
    micBtn.classList.remove('text-brand-orange', 'animate-pulse');
  }
}

function toggleVoiceMic(): void {
  if (isVoiceActive && speechRecognition) {
    speechRecognition.stop();
    setMicVisual(false);
    showToast('Voice input stopped.');
    return;
  }

  const SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechCtor) {
    setMicVisual(false);
    showToast('Voice input is not supported in this browser.');
    return;
  }

  try {
    const recognition = new SpeechCtor();
    speechRecognition = recognition;
    recognition.lang = 'hi-IN';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalTranscript = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const res = event.results[i];
        const part = res[0]?.transcript ?? '';
        if (res.isFinal) {
          finalTranscript += `${part} `;
        } else {
          interim += part;
        }
      }
      const chatInput = byId<HTMLInputElement>('chatInput');
      if (chatInput) {
        chatInput.value = (finalTranscript || interim).trim();
      }
      if (finalTranscript.trim()) {
        recognition.stop();
        void submitChatMessage();
      }
    };

    recognition.onerror = () => {
      setMicVisual(false);
      speechRecognition = null;
      showToast('Voice input could not capture audio.');
    };

    recognition.onend = () => {
      setMicVisual(false);
      speechRecognition = null;
    };

    recognition.start();
    setMicVisual(true);
    showToast('Listening... speak your prompt');
  } catch {
    setMicVisual(false);
    speechRecognition = null;
    showToast('Could not start voice input.');
  }
}

function detectCodeTabFromLanguage(lang: string): CodeTab {
  const normalized = lang.trim().toLowerCase();
  if (normalized === 'css' || normalized === 'scss') return 'css';
  if (normalized === 'js' || normalized === 'javascript' || normalized === 'ts' || normalized === 'typescript') {
    return 'js';
  }
  return 'html';
}

function createCodeCardElement(codeSnippet: string, language = 'html'): HTMLElement {
  const cleanLang = language.trim() || 'code';
  const targetTab = detectCodeTabFromLanguage(cleanLang);

  const wrapper = document.createElement('div');
  wrapper.className = 'mt-3 bg-slate-900 text-slate-100 rounded-xl p-3 code-font text-xs overflow-x-auto border border-slate-800';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between border-b border-slate-800 pb-2 mb-2 text-[11px] text-slate-400';

  const label = document.createElement('span');
  label.textContent = cleanLang.toUpperCase() + ' Component';

  const actions = document.createElement('div');
  actions.className = 'flex gap-2';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'hover:text-white';
  const copyIcon = document.createElement('i');
  copyIcon.className = 'fa-regular fa-copy mr-1';
  copyBtn.append(copyIcon, document.createTextNode('Copy'));
  copyBtn.addEventListener('click', () => {
    void copyTextToClipboard(codeSnippet);
  });

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'text-brand-orange hover:underline font-bold';
  const sendIcon = document.createElement('i');
  sendIcon.className = 'fa-solid fa-square-arrow-up-right mr-1';
  sendBtn.append(sendIcon, document.createTextNode('Send to Workspace'));
  sendBtn.addEventListener('click', () => {
    transferToWorkspace(codeSnippet, targetTab);
  });

  actions.append(copyBtn, sendBtn);
  header.append(label, actions);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = codeSnippet;
  pre.appendChild(code);

  wrapper.append(header, pre);
  return wrapper;
}

function appendInlineMarkdown(container: HTMLElement, text: string): void {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      container.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      container.appendChild(strong);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.className = 'bg-slate-200/80 text-slate-900 px-1 py-0.5 rounded code-font text-xs';
      code.textContent = token.slice(1, -1);
      container.appendChild(code);
    }
    lastIdx = tokenRegex.lastIndex;
  }

  if (lastIdx < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function renderFormattedTextBlock(host: HTMLElement, rawText: string): void {
  const lines = rawText.split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const p = document.createElement('p');
    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      p.className = 'font-bold text-slate-900 pt-1';
      appendInlineMarkdown(p, trimmed.replace(/^#{1,3}\s+/, ''));
    } else {
      appendInlineMarkdown(p, line);
    }
    host.appendChild(p);
  });
}

function renderMarkdownIntoHost(host: HTMLElement, markdownText: string): void {
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(markdownText)) !== null) {
    const before = markdownText.slice(lastIndex, match.index);
    if (before.trim()) {
      renderFormattedTextBlock(host, before);
    }
    const lang = match[1] || 'html';
    const code = match[2].replace(/\n$/, '');
    host.appendChild(createCodeCardElement(code, lang));
    lastIndex = fenceRegex.lastIndex;
  }

  const remaining = markdownText.slice(lastIndex);
  if (remaining.trim()) {
    renderFormattedTextBlock(host, remaining);
  }
}

function appendMessage(
  sender: 'user' | 'ai',
  buildBody: (paragraphHost: HTMLElement) => void
): HTMLElement | null {
  const container = byId<HTMLElement>('chatMessages');
  if (!container) return null;

  const msgDiv = document.createElement('div');
  msgDiv.className = 'flex gap-3 animate-fade-in';

  if (sender === 'user') {
    const avatar = document.createElement('div');
    avatar.className =
      'w-8 h-8 rounded-full bg-slate-800 text-white flex-shrink-0 flex items-center justify-center text-xs font-bold ml-auto order-2';
    avatar.textContent = 'YOU';

    const bubble = document.createElement('div');
    bubble.className = 'bg-brand-blue text-white rounded-2xl rounded-tr-none p-4 max-w-2xl text-sm ml-auto order-1 shadow-sm';
    const body = document.createElement('div');
    body.className = 'whitespace-pre-wrap break-words space-y-1';
    buildBody(body);
    bubble.appendChild(body);

    msgDiv.append(avatar, bubble);
  } else {
    const avatar = document.createElement('div');
    avatar.className =
      'w-8 h-8 rounded-full bg-brand-blue text-white flex-shrink-0 flex items-center justify-center text-xs font-bold';
    avatar.textContent = 'AI';

    const bubble = document.createElement('div');
    bubble.className =
      'bg-slate-100 rounded-2xl rounded-tl-none p-4 max-w-2xl text-slate-800 text-sm space-y-2 shadow-sm';
    const body = document.createElement('div');
    body.className = 'space-y-2 break-words';
    buildBody(body);
    bubble.appendChild(body);

    msgDiv.append(avatar, bubble);
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
  return msgDiv;
}

function appendThinkingBubble(): HTMLElement | null {
  return appendMessage('ai', (host) => {
    const p = document.createElement('p');
    p.className = 'text-slate-500 italic';
    p.textContent = 'Gemini is thinking...';
    host.appendChild(p);
  });
}

async function submitChatMessage(): Promise<void> {
  if (isAiLoading) {
    showToast('Please wait for the current AI response.');
    return;
  }

  const input = byId<HTMLInputElement>('chatInput');
  if (!input) return;

  const typedText = input.value.trim();
  const fileAttachment = attachedTextFile;
  if (!typedText && !fileAttachment) return;

  const displayText = fileAttachment
    ? `${typedText || 'Please review and explain this attached file.'}\n[Attached: ${fileAttachment.name}]`
    : typedText;

  const apiTurnText = fileAttachment
    ? `${typedText || 'Please review and explain this attached file.'}\n\n--- Attached File: ${fileAttachment.name} ---\n${fileAttachment.content}`
    : typedText;

  appendMessage('user', (host) => {
    const p = document.createElement('p');
    p.textContent = displayText;
    host.appendChild(p);
  });

  input.value = '';
  attachedTextFile = null;
  const fileInput = byId<HTMLInputElement>('chatFileInput');
  if (fileInput) fileInput.value = '';
  const fileStatus = byId<HTMLElement>('fileStatus');
  if (fileStatus) fileStatus.textContent = '';

  chatConversation.push({ role: 'user', text: displayText });
  const recentHistory = chatConversation.slice(-16).map((turn) => ({ ...turn }));
  if (recentHistory.length > 0 && apiTurnText !== displayText) {
    recentHistory[recentHistory.length - 1] = {
      role: 'user',
      text: apiTurnText,
    };
  }

  isAiLoading = true;
  const loadingBubble = appendThinkingBubble();

  try {
    const aiText = await callGeminiApi({
      messages: recentHistory,
      systemInstruction: CHATCODE_SYSTEM_INSTRUCTION,
    });
    loadingBubble?.remove();
    chatConversation.push({ role: 'model', text: aiText });
    appendMessage('ai', (host) => {
      renderMarkdownIntoHost(host, aiText);
    });
  } catch (err) {
    loadingBubble?.remove();
    chatConversation.pop();
    const message = err instanceof Error ? err.message : 'Failed to get Gemini response.';
    appendMessage('ai', (host) => {
      const p = document.createElement('p');
      p.className = 'text-red-600 font-medium';
      p.textContent = `Error: ${message}`;
      host.appendChild(p);
    });
    showToast(message);
  } finally {
    isAiLoading = false;
  }
}

function handleChatSubmit(event: Event): void {
  event.preventDefault();
  void submitChatMessage();
}

function transferToWorkspace(codeSnippet: string, targetTab: CodeTab = 'html'): void {
  const editor = byId<HTMLTextAreaElement>(`code-${targetTab}`);
  if (editor) {
    editor.value = codeSnippet;
  }
  selectCodeTab(targetTab);
  switchTab('code');
  showToast('Code transferred to Workspace!');
}

function startNewChat(): void {
  const container = byId<HTMLElement>('chatMessages');
  if (!container) return;

  chatConversation = [];
  attachedTextFile = null;
  const fileStatus = byId<HTMLElement>('fileStatus');
  if (fileStatus) fileStatus.textContent = '';

  container.replaceChildren();
  appendMessage('ai', (host) => {
    const p1 = document.createElement('p');
    p1.className = 'font-semibold text-brand-blue';
    p1.textContent = 'New Chat Started 🚀';

    const p2 = document.createElement('p');
    p2.textContent = 'How can I help you plan or code your next idea today?';

    host.append(p1, p2);
  });
  showToast('New conversation ready');
}

function clearChatHistory(): void {
  startNewChat();
}

// ==========================================
// CODE WORKSPACE FUNCTIONS
// ==========================================
function getActiveCodeTextarea(): HTMLTextAreaElement | null {
  return byId<HTMLTextAreaElement>(`code-${activeCodeTab}`);
}

function updateLineNumbers(): void {
  const lineNumbersEl = byId<HTMLElement>('codeLineNumbers');
  const activeEditor = getActiveCodeTextarea();
  if (!lineNumbersEl || !activeEditor) return;

  const lineCount = Math.max(1, activeEditor.value.split('\n').length);
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    lines.push(String(i));
  }
  lineNumbersEl.textContent = lines.join('\n');
  lineNumbersEl.scrollTop = activeEditor.scrollTop;
}

function selectCodeTab(type: CodeTab): void {
  activeCodeTab = type;

  document.querySelectorAll<HTMLElement>('.code-editor-area').forEach((el) => {
    el.classList.add('hidden');
  });
  document.querySelectorAll<HTMLElement>('.code-tab-btn').forEach((btn) => {
    btn.classList.remove('bg-slate-800', 'text-brand-orange', 'border', 'border-slate-700');
    btn.classList.add('bg-transparent', 'text-slate-400');
  });

  byId<HTMLElement>(`code-${type}`)?.classList.remove('hidden');
  const activeBtn = byId<HTMLElement>(`tab-btn-${type}`);
  if (activeBtn) {
    activeBtn.classList.remove('bg-transparent', 'text-slate-400');
    activeBtn.classList.add('bg-slate-800', 'text-brand-orange', 'border', 'border-slate-700');
  }

  updateLineNumbers();
}

function buildCombinedPreviewHtml(): string {
  const html = byId<HTMLTextAreaElement>('code-html')?.value ?? '';
  const css = byId<HTMLTextAreaElement>('code-css')?.value ?? '';
  const js = byId<HTMLTextAreaElement>('code-js')?.value ?? '';

  let result = html.trim() ? html : '<!DOCTYPE html>\n<html>\n<head></head>\n<body></body>\n</html>';

  if (css.trim()) {
    const safeCss = css.replace(/<\/style/gi, '<\\/style');
    const styleTag = `<style>\n${safeCss}\n</style>`;
    if (/<\/head>/i.test(result)) {
      result = result.replace(/<\/head>/i, `${styleTag}\n</head>`);
    } else {
      result = `${styleTag}\n${result}`;
    }
  }

  if (js.trim()) {
    const safeJs = js.replace(/<\/script/gi, '<\\/script');
    const scriptTag = `<script>\n${safeJs}\n</script>`;
    if (/<\/body>/i.test(result)) {
      result = result.replace(/<\/body>/i, `${scriptTag}\n</body>`);
    } else {
      result = `${result}\n${scriptTag}`;
    }
  }

  return result;
}

function runCodePreview(): void {
  const iframe = byId<HTMLIFrameElement>('codePreviewFrame');
  if (!iframe) return;
  iframe.srcdoc = buildCombinedPreviewHtml();
}

function copyCurrentCode(): void {
  const activeEditor = getActiveCodeTextarea();
  if (!activeEditor) return;
  void copyTextToClipboard(activeEditor.value);
}

function downloadCodeFiles(): void {
  const combined = buildCombinedPreviewHtml();
  const blob = new Blob([combined], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chatcode-export.html';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded chatcode-export.html');
}

function clearCodeEditors(): void {
  const activeEditor = getActiveCodeTextarea();
  if (activeEditor) {
    activeEditor.value = '';
  }
  updateLineNumbers();
  runCodePreview();
  showToast('Editor cleared.');
}

// ==========================================
// DEVELOPER TOOLS FUNCTIONS (CLIENT-SIDE)
// ==========================================
function formatJson(): void {
  const input = byId<HTMLTextAreaElement>('toolJsonInput');
  if (!input) return;
  try {
    const parsed = JSON.parse(input.value);
    input.value = JSON.stringify(parsed, null, 2);
    showToast('JSON Formatted Successfully');
  } catch {
    showToast('Invalid JSON string');
  }
}

function minifyJson(): void {
  const input = byId<HTMLTextAreaElement>('toolJsonInput');
  if (!input) return;
  try {
    const parsed = JSON.parse(input.value);
    input.value = JSON.stringify(parsed);
    showToast('JSON Minified');
  } catch {
    showToast('Invalid JSON string');
  }
}

function updateColorTool(): void {
  const colorInput = byId<HTMLInputElement>('toolColorInput');
  const hexEl = byId<HTMLElement>('colorHex');
  const rgbEl = byId<HTMLElement>('colorRgb');
  if (!colorInput || !hexEl || !rgbEl) return;

  const hex = colorInput.value;
  hexEl.textContent = `HEX: ${hex.toUpperCase()}`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  rgbEl.textContent = `RGB: rgb(${r}, ${g}, ${b})`;
}

function copyColorHex(): void {
  const colorInput = byId<HTMLInputElement>('toolColorInput');
  if (!colorInput) return;
  void copyTextToClipboard(colorInput.value.toUpperCase());
}

function convertCase(type: 'upper' | 'lower' | 'camel' | 'kebab'): void {
  const input = byId<HTMLInputElement>('toolCaseInput');
  if (!input) return;
  const txt = input.value;
  if (!txt) return;

  if (type === 'upper') {
    input.value = txt.toUpperCase();
  } else if (type === 'lower') {
    input.value = txt.toLowerCase();
  } else if (type === 'camel') {
    const words = txt
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim()
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean);
    input.value = words
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');
  } else if (type === 'kebab') {
    const words = txt
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim()
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean);
    input.value = words.map((w) => w.toLowerCase()).join('-');
  }

  showToast(`Converted to ${type}`);
}

function encodeUrl(): void {
  const input = byId<HTMLTextAreaElement>('toolUrlInput');
  if (!input) return;
  input.value = encodeURIComponent(input.value);
  showToast('URL Encoded');
}

function decodeUrl(): void {
  const input = byId<HTMLTextAreaElement>('toolUrlInput');
  if (!input) return;
  try {
    input.value = decodeURIComponent(input.value);
    showToast('URL Decoded');
  } catch {
    showToast('Invalid URL-encoded string');
  }
}

function calculateWordStats(): void {
  const input = byId<HTMLTextAreaElement>('toolWordInput');
  const wordsEl = byId<HTMLElement>('statWords');
  const charsEl = byId<HTMLElement>('statChars');
  const timeEl = byId<HTMLElement>('statTime');
  if (!input || !wordsEl || !charsEl || !timeEl) return;

  const trimmed = input.value.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const chars = input.value.length;
  const readingTime = Math.ceil((words / 200) * 60);

  wordsEl.textContent = String(words);
  charsEl.textContent = String(chars);
  timeEl.textContent = `${readingTime}s`;
}

function encodeBase64(): void {
  const input = byId<HTMLTextAreaElement>('toolBase64Input');
  if (!input) return;
  try {
    const bytes = new TextEncoder().encode(input.value);
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    input.value = btoa(binary);
    showToast('Base64 Encoded');
  } catch {
    showToast('Error encoding Base64');
  }
}

function decodeBase64(): void {
  const input = byId<HTMLTextAreaElement>('toolBase64Input');
  if (!input) return;
  try {
    const binary = atob(input.value.trim());
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    input.value = new TextDecoder().decode(bytes);
    showToast('Base64 Decoded');
  } catch {
    showToast('Invalid Base64 string');
  }
}

// ==========================================
// PRICING & SUPPORT
// ==========================================
function toggleBilling(mode: BillingMode): void {
  billingMode = mode;

  const monthlyBtn = byId<HTMLElement>('btn-monthly');
  const yearlyBtn = byId<HTMLElement>('btn-yearly');
  const pricePro = byId<HTMLElement>('price-pro');
  const priceTeam = byId<HTMLElement>('price-team');
  const periodPro = byId<HTMLElement>('price-pro-period');
  const periodTeam = byId<HTMLElement>('price-team-period');

  if (!monthlyBtn || !yearlyBtn || !pricePro || !priceTeam) return;

  if (mode === 'yearly') {
    yearlyBtn.classList.add('bg-white', 'text-slate-900', 'shadow-sm');
    monthlyBtn.classList.remove('bg-white', 'text-slate-900', 'shadow-sm');
    pricePro.textContent = '$7.99';
    priceTeam.textContent = '$23.99';
    if (periodPro) periodPro.textContent = '/ month (billed yearly)';
    if (periodTeam) periodTeam.textContent = '/ month (billed yearly)';
  } else {
    monthlyBtn.classList.add('bg-white', 'text-slate-900', 'shadow-sm');
    yearlyBtn.classList.remove('bg-white', 'text-slate-900', 'shadow-sm');
    pricePro.textContent = '$9.99';
    priceTeam.textContent = '$29.99';
    if (periodPro) periodPro.textContent = '/ month';
    if (periodTeam) periodTeam.textContent = '/ month';
  }
}

function handleSupportSubmit(event: Event): void {
  event.preventDefault();
  showToast('Message sent! Support will contact you shortly.');
  (event.target as HTMLFormElement).reset();
}

// ==========================================
// PROJECT ZIP INSPECTOR + GEMINI ANALYSIS
// ==========================================
function isSafeZipPath(rawName: string): boolean {
  if (!rawName || rawName.includes('\0') || /[\x00-\x1F\x7F]/.test(rawName)) {
    return false;
  }
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return false;
  }
  const segments = normalized.split('/');
  if (segments.some((part) => part === '..')) {
    return false;
  }
  return true;
}

type ZipEntryKind = 'keep' | 'env-secret' | 'skip-dot';

function normalizeZipPath(rawName: string): string {
  return rawName.replace(/\\/g, '/').replace(/^\.\//, '');
}

function classifyZipEntry(normalizedPath: string): ZipEntryKind {
  const parts = normalizedPath.split('/').filter(Boolean);
  if (parts.length === 0) return 'skip-dot';

  const dirParts = parts.slice(0, -1);
  if (dirParts.some((part) => part.startsWith('.') && part !== '.github')) {
    return 'skip-dot';
  }

  const base = parts[parts.length - 1];
  if (base === '.env' || base === '.env.local') {
    return 'env-secret';
  }

  if (base.startsWith('.')) {
    return ALLOWED_DOTFILES.has(base) ? 'keep' : 'skip-dot';
  }

  return 'keep';
}

interface PreparedZipEntry {
  entry: JSZipEntryLike;
  path: string;
  kind: ZipEntryKind;
}

async function processSafeZipEntries(
  preparedEntries: PreparedZipEntry[]
): Promise<{
  extracted: ExtractedProjectFile[];
  notSent: string[];
  staticFiles: Map<string, string>;
}> {
  const sorted = [...preparedEntries].sort((a, b) => {
    const aImp = CHATCODE_IMPORTANT.test(a.path) ? 0 : 1;
    const bImp = CHATCODE_IMPORTANT.test(b.path) ? 0 : 1;
    if (aImp !== bImp) return aImp - bImp;
    return a.path.length - b.path.length || a.path.localeCompare(b.path);
  });

  const encoder = new TextEncoder();
  const staticFiles = new Map<string, string>();
  const extracted: ExtractedProjectFile[] = [];
  const notSent: string[] = [];
  let totalUtf8Bytes = 0;

  for (const item of sorted) {
    const { entry, path, kind } = item;
    if (kind === 'env-secret') {
      notSent.push(path);
      continue;
    }

    if (BINARY_EXT_RE.test(path)) {
      notSent.push(path);
      continue;
    }

    const uncompressed = entry._data?.uncompressedSize ?? 0;
    if (uncompressed > MAX_SINGLE_UNCOMPRESSED_BYTES) {
      notSent.push(path);
      continue;
    }

    const isLockFile = LOCK_FILE_RE.test(path);
    const isPackageLock = /(^|\/)package-lock\.json$/i.test(path);
    if (isLockFile) {
      notSent.push(path);
      if (isPackageLock) {
        try {
          const lockRaw = await entry.async('string');
          if (!lockRaw.includes('\0') && encoder.encode(lockRaw).byteLength <= MAX_SINGLE_UNCOMPRESSED_BYTES) {
            staticFiles.set(path, lockRaw);
          }
        } catch {
          // Ignore unreadable package-lock.json
        }
      }
      continue;
    }

    let raw: string;
    try {
      raw = await entry.async('string');
    } catch {
      notSent.push(path);
      continue;
    }

    if (raw.includes('\0') || encoder.encode(raw).byteLength > MAX_SINGLE_UNCOMPRESSED_BYTES) {
      notSent.push(path);
      continue;
    }

    staticFiles.set(path, raw);

    const truncated = raw.length > MAX_ZIP_CHARS_PER_FILE;
    const content = truncated ? `${raw.slice(0, MAX_ZIP_CHARS_PER_FILE)}\n/* ...TRUNCATED... */` : raw;
    const contentBytes = encoder.encode(content).byteLength;

    if (totalUtf8Bytes + contentBytes > MAX_ZIP_TOTAL_UTF8_BYTES) {
      notSent.push(path);
      continue;
    }

    totalUtf8Bytes += contentBytes;
    extracted.push({ path, content, truncated });
  }

  return { extracted, notSent, staticFiles };
}

async function inspectProjectZip(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const status = byId<HTMLElement>('projectZipStatus');
  const details = byId<HTMLElement>('projectZipDetails');
  const promptBtn = byId<HTMLElement>('projectPromptBtn');
  const geminiBtn = byId<HTMLElement>('projectGeminiAnalyzeBtn');
  if (!status || !details || !promptBtn || !geminiBtn) return;

  promptBtn.classList.add('hidden');
  geminiBtn.classList.add('hidden');
  details.classList.add('hidden');
  details.replaceChildren();

  if (!/\.zip$/i.test(file.name)) {
    status.textContent = 'Please select a ZIP file.';
    input.value = '';
    return;
  }

  if (file.size > MAX_ZIP_FILE_BYTES) {
    status.textContent = 'ZIP is larger than 3 MB. Please upload a smaller project archive.';
    input.value = '';
    return;
  }

  if (typeof window.JSZip === 'undefined') {
    status.textContent = 'ZIP reader could not load. Check your internet connection and try again.';
    input.value = '';
    return;
  }

  status.textContent = 'Reading ZIP file structure…';

  try {
    const zip = await window.JSZip.loadAsync(file, { checkCRC32: false });
    const allEntries = Object.values(zip.files);

    if (allEntries.length > MAX_ZIP_ENTRIES) {
      status.textContent = `ZIP contains too many entries (${allEntries.length}). Maximum supported is ${MAX_ZIP_ENTRIES}.`;
      input.value = '';
      return;
    }

    const fileEntries = allEntries.filter((entry) => !entry.dir);

    let totalUncompressedBytes = 0;
    let oversizedEntryFound = false;
    const preparedEntries: PreparedZipEntry[] = [];

    for (const entry of fileEntries) {
      const uncompressed = entry._data?.uncompressedSize ?? 0;
      if (uncompressed > MAX_SINGLE_UNCOMPRESSED_BYTES) {
        oversizedEntryFound = true;
        break;
      }
      totalUncompressedBytes += uncompressed;
      if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        oversizedEntryFound = true;
        break;
      }

      if (!isSafeZipPath(entry.name)) {
        continue;
      }

      const normalized = normalizeZipPath(entry.name);
      if (CHATCODE_IGNORE.test(normalized)) {
        continue;
      }

      const kind = classifyZipEntry(normalized);
      if (kind === 'skip-dot') {
        continue;
      }

      preparedEntries.push({ entry, path: normalized, kind });
    }

    if (oversizedEntryFound) {
      status.textContent = 'ZIP extracted size exceeds safety limits (5 MB per file or 40 MB total).';
      input.value = '';
      return;
    }

    const allPaths = preparedEntries.map((item) => item.path);
    const important = preparedEntries
      .filter((item) => CHATCODE_IMPORTANT.test(item.path))
      .map((item) => item.path);
    const skippedCount = fileEntries.length - preparedEntries.length;

    const { extracted, notSent, staticFiles } = await processSafeZipEntries(preparedEntries);
    const checks = runStaticChecks(staticFiles, allPaths);

    chatCodeProject = {
      name: file.name,
      files: allPaths.slice(0, MAX_VISIBLE_ZIP_PATHS),
      allPaths,
      notSent,
      checks,
      important,
      extracted,
      total: allPaths.length,
      skipped: skippedCount,
    };

    status.textContent = `ZIP loaded (${extracted.length} readable source files ready for Gemini analysis).`;

    const addDetailRow = (label: string, value: string): void => {
      const row = document.createElement('div');
      const strong = document.createElement('b');
      strong.textContent = label;
      row.append(strong, document.createTextNode(` ${value}`));
      details.appendChild(row);
    };

    addDetailRow('Project:', file.name);
    addDetailRow('Project files:', String(allPaths.length));
    addDetailRow('Ignored / unsafe paths:', String(skippedCount));
    addDetailRow(
      'Key files detected:',
      important.length ? important.slice(0, 8).join(', ') : 'Not detected in the first-level scan'
    );

    const problems = checks.filter((c) => c.level === 'problem');
    const warnings = checks.filter((c) => c.level === 'warning');
    addDetailRow(
      'Checks:',
      `${problems.length} problems, ${warnings.length} warnings`
    );

    problems.slice(0, 5).forEach((item) => {
      const pRow = document.createElement('div');
      pRow.textContent = `Problem: ${item.text}`;
      details.appendChild(pRow);
    });

    const note = document.createElement('div');
    note.className = 'mt-1 text-slate-500';
    note.textContent = `Showing ${Math.min(allPaths.length, MAX_VISIBLE_ZIP_PATHS)} of ${allPaths.length} file paths (max ${MAX_VISIBLE_ZIP_PATHS}). Large dependency/build folders are excluded.`;
    details.appendChild(note);

    if (allPaths.length > 0) {
      const pathListEl = document.createElement('div');
      pathListEl.className = 'max-h-32 overflow-y-auto whitespace-pre-wrap break-all';
      pathListEl.textContent = allPaths.slice(0, MAX_VISIBLE_ZIP_PATHS).join('\n');
      details.appendChild(pathListEl);
    }

    details.classList.remove('hidden');
    promptBtn.classList.remove('hidden');
    geminiBtn.classList.remove('hidden');
    showToast('Project ZIP structure inspected');
  } catch {
    status.textContent = 'Could not read this ZIP. Please check that the archive is valid.';
  }

  input.value = '';
}

function buildProjectReviewPrompt(): string {
  const checkLines = chatCodeProject.checks.length
    ? chatCodeProject.checks.map((c) => `[${c.level.toUpperCase()}] ${c.text}`).join('\n')
    : 'No static checks ran.';

  const allPathsSection = chatCodeProject.allPaths.length
    ? chatCodeProject.allPaths.join('\n')
    : 'None';

  const notSentSection = chatCodeProject.notSent.length
    ? chatCodeProject.notSent.join('\n')
    : 'None';

  const fileContentsSection = chatCodeProject.extracted.length
    ? chatCodeProject.extracted
        .map((f) => `\n=== FILE: ${f.path}${f.truncated ? ' [TRUNCATED]' : ''} ===\n${f.content}`)
        .join('\n')
    : 'No readable source files extracted.';

  return [
    'Aap ChatCode ke senior code reviewer hain. Sirf neeche diye gaye facts, file paths aur file content ke aadhar par project ka review karein.',
    'Niyam:',
    '- Jawab aasan aur chhote Hindi vakyo (short, simple sentences) mein dein.',
    '- Static Check Results ko sach (true facts) maanein.',
    '- Jis file ka content nahi bheja gaya ("Not sent" list) ya jo [TRUNCATED] hai, uske baare mein andaza na lagayein — use D) Doubts mein likhein.',
    '',
    'Jawab bilkul isi exact format aur headings ke saath dein:',
    'A) Build and deploy problems',
    'B) Feature problems',
    'C) Security problems',
    'D) Doubts',
    'E) What is correct',
    'F) Next step (maximum 3 short points)',
    '',
    `Project archive: ${chatCodeProject.name}`,
    `Total visible files: ${chatCodeProject.total}`,
    `Files sent to Gemini: ${chatCodeProject.extracted.length}`,
    `Files not sent: ${chatCodeProject.notSent.length}`,
    `Important files detected: ${chatCodeProject.important.join(', ') || 'None detected'}`,
    '',
    'Static Check Results (true facts):',
    checkLines,
    '',
    `All File Paths (${chatCodeProject.allPaths.length}):`,
    allPathsSection,
    '',
    `Not Sent File List (${chatCodeProject.notSent.length}):`,
    notSentSection,
    '',
    `Sent File Contents (${chatCodeProject.extracted.length} files):`,
    fileContentsSection,
  ].join('\n');
}

function copyProjectReviewPrompt(): void {
  void copyTextToClipboard(buildProjectReviewPrompt());
}

async function analyzeProjectWithGemini(): Promise<void> {
  if (!chatCodeProject.name) {
    showToast('Please upload a project ZIP first.');
    return;
  }
  if (isAiLoading) {
    showToast('Please wait for the current AI response.');
    return;
  }

  const analyzeBtn = byId<HTMLButtonElement>('projectGeminiAnalyzeBtn');
  if (analyzeBtn) {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing with Gemini...';
  }

  appendMessage('user', (host) => {
    const p = document.createElement('p');
    p.textContent = `Analyze project ZIP "${chatCodeProject.name}" (${chatCodeProject.total} files, ${chatCodeProject.extracted.length} source files extracted).`;
    host.appendChild(p);
  });

  const reviewPrompt = buildProjectReviewPrompt();
  chatConversation.push({ role: 'user', text: `[ZIP analysis requested: ${chatCodeProject.name}]` });
  isAiLoading = true;
  const loadingBubble = appendThinkingBubble();

  try {
    const aiText = await callGeminiApi({
      prompt: reviewPrompt,
      systemInstruction: CHATCODE_SYSTEM_INSTRUCTION,
    });
    loadingBubble?.remove();
    chatConversation.push({ role: 'model', text: aiText });
    appendMessage('ai', (host) => {
      renderMarkdownIntoHost(host, aiText);
    });
    showToast('Gemini project analysis complete!');
  } catch (err) {
    loadingBubble?.remove();
    chatConversation.pop();
    const message = err instanceof Error ? err.message : 'Failed to analyze project.';
    appendMessage('ai', (host) => {
      const p = document.createElement('p');
      p.className = 'text-red-600 font-medium';
      p.textContent = `Error: ${message}`;
      host.appendChild(p);
    });
    showToast(message);
  } finally {
    isAiLoading = false;
    if (analyzeBtn) {
      analyzeBtn.disabled = false;
      analyzeBtn.replaceChildren();
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-wand-magic-sparkles mr-1';
      analyzeBtn.append(icon, document.createTextNode(' Gemini se Analyze Karein'));
    }
  }
}

function copyBuildWorkflowPrompt(): void {
  const prompt =
    'Work with me step by step. First discuss the requirement and ask clarifying questions only when essential. Then create a clear implementation plan. Do not write or change code until I approve the plan. After approval, implement only the first approved step, preserve the current design and existing working features, explain exactly which files changed, and provide a test checklist. Wait for my confirmation before moving to the next step.';
  void copyTextToClipboard(prompt);
}

// ==========================================
// PWA INSTALL
// ==========================================
function installPwaApp(): void {
  if (deferredPrompt) {
    void deferredPrompt.prompt();
    void deferredPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        showToast('App Installed to Home Screen!');
      }
      deferredPrompt = null;
    });
  } else {
    showToast('PWA install available via browser menu.');
  }
}

// ==========================================
// INITIALIZATION & EVENT WIRING
// ==========================================
function renderInitialHistory(): void {
  const historyList = byId<HTMLElement>('chatHistoryList');
  if (!historyList) return;

  historyList.replaceChildren();
  const sampleTitles = ['Landing Page Layout', 'Todo App Architecture'];
  sampleTitles.forEach((title) => {
    const item = document.createElement('div');
    item.className =
      'p-2 text-xs text-slate-700 hover:bg-slate-200/60 rounded-lg cursor-pointer truncate font-medium';
    const icon = document.createElement('i');
    icon.className = 'fa-regular fa-comment mr-1.5 text-brand-blue';
    item.append(icon, document.createTextNode(title));
    item.addEventListener('click', startNewChat);
    historyList.appendChild(item);
  });
}

export function initChatCode(): void {
  // Tab switching buttons & cards
  document.querySelectorAll<HTMLElement>('[data-switch-tab]').forEach((el) => {
    const target = el.dataset.switchTab as PageTab | undefined;
    if (!target) return;
    el.addEventListener('click', () => switchTab(target));
    if (el.getAttribute('role') === 'button') {
      el.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          switchTab(target);
        }
      });
    }
  });

  // Demo modal triggers
  document.querySelectorAll<HTMLElement>('[data-open-demo]').forEach((el) => {
    el.addEventListener('click', openDemoModal);
  });
  byId<HTMLElement>('closeDemoModalBtn')?.addEventListener('click', closeDemoModal);
  byId<HTMLElement>('demoTryChatBtn')?.addEventListener('click', () => {
    closeDemoModal();
    switchTab('chat');
  });

  // Search modal
  byId<HTMLElement>('searchToggleBtn')?.addEventListener('click', toggleSearchModal);
  byId<HTMLElement>('closeSearchModalBtn')?.addEventListener('click', toggleSearchModal);
  byId<HTMLInputElement>('globalSearchInput')?.addEventListener('input', (e) => {
    handleSearchQuery((e.target as HTMLInputElement).value);
  });
  document.querySelectorAll<HTMLElement>('[data-search-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      const tab = el.dataset.searchTab as PageTab | undefined;
      if (tab) {
        toggleSearchModal();
        switchTab(tab);
      }
    });
  });

  // Payment modal
  document.querySelectorAll<HTMLElement>('.open-payment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const plan = btn.dataset.plan || 'Pro Plan';
      openPaymentModal(plan);
    });
  });
  byId<HTMLElement>('closePaymentModalBtn')?.addEventListener('click', closePaymentModal);
  byId<HTMLElement>('confirmPaymentInterestBtn')?.addEventListener('click', confirmPaymentInterest);

  // Backdrop click & Escape key to close modals
  (['demoModal', 'searchModal', 'paymentModal'] as const).forEach((modalId) => {
    const modal = byId<HTMLElement>(modalId);
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllModals();
    }
  });

  // Chat controls
  byId<HTMLElement>('newChatBtn')?.addEventListener('click', startNewChat);
  byId<HTMLElement>('clearHistoryBtn')?.addEventListener('click', clearChatHistory);
  byId<HTMLElement>('copyWorkflowPromptBtn')?.addEventListener('click', copyBuildWorkflowPrompt);
  byId<HTMLFormElement>('chatForm')?.addEventListener('submit', handleChatSubmit);
  byId<HTMLElement>('chatFileTriggerBtn')?.addEventListener('click', () => {
    byId<HTMLInputElement>('chatFileInput')?.click();
  });
  byId<HTMLInputElement>('chatFileInput')?.addEventListener('change', (e) => {
    void handleFileSelected(e);
  });
  byId<HTMLElement>('micBtn')?.addEventListener('click', toggleVoiceMic);

  document.querySelectorAll<HTMLElement>('[data-quick-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.quickPrompt;
      if (prompt) sendQuickPrompt(prompt);
    });
  });

  // Project ZIP analyzer
  byId<HTMLElement>('projectZipUploadBtn')?.addEventListener('click', () => {
    byId<HTMLInputElement>('projectZipInput')?.click();
  });
  byId<HTMLInputElement>('projectZipInput')?.addEventListener('change', (e) => {
    void inspectProjectZip(e);
  });
  byId<HTMLElement>('projectPromptBtn')?.addEventListener('click', copyProjectReviewPrompt);
  byId<HTMLElement>('projectGeminiAnalyzeBtn')?.addEventListener('click', () => {
    void analyzeProjectWithGemini();
  });

  // Code workspace
  document.querySelectorAll<HTMLElement>('[data-code-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.codeTab as CodeTab | undefined;
      if (tab) selectCodeTab(tab);
    });
  });
  byId<HTMLElement>('runCodeBtn')?.addEventListener('click', runCodePreview);
  byId<HTMLElement>('refreshPreviewBtn')?.addEventListener('click', runCodePreview);
  byId<HTMLElement>('copyCodeBtn')?.addEventListener('click', copyCurrentCode);
  byId<HTMLElement>('exportCodeBtn')?.addEventListener('click', downloadCodeFiles);
  byId<HTMLElement>('clearCodeBtn')?.addEventListener('click', clearCodeEditors);

  (['code-html', 'code-css', 'code-js'] as const).forEach((editorId) => {
    const editor = byId<HTMLTextAreaElement>(editorId);
    editor?.addEventListener('input', updateLineNumbers);
    editor?.addEventListener('scroll', () => {
      const lineNumbersEl = byId<HTMLElement>('codeLineNumbers');
      if (lineNumbersEl) {
        lineNumbersEl.scrollTop = editor.scrollTop;
      }
    });
  });

  // Developer tools
  byId<HTMLElement>('formatJsonBtn')?.addEventListener('click', formatJson);
  byId<HTMLElement>('minifyJsonBtn')?.addEventListener('click', minifyJson);
  byId<HTMLElement>('copyJsonBtn')?.addEventListener('click', () => {
    const val = byId<HTMLTextAreaElement>('toolJsonInput')?.value ?? '';
    void copyTextToClipboard(val);
  });
  byId<HTMLInputElement>('toolColorInput')?.addEventListener('input', updateColorTool);
  byId<HTMLElement>('copyColorHexBtn')?.addEventListener('click', copyColorHex);
  document.querySelectorAll<HTMLElement>('[data-case]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.case as 'upper' | 'lower' | 'camel' | 'kebab' | undefined;
      if (type) convertCase(type);
    });
  });
  byId<HTMLElement>('encodeUrlBtn')?.addEventListener('click', encodeUrl);
  byId<HTMLElement>('decodeUrlBtn')?.addEventListener('click', decodeUrl);
  byId<HTMLTextAreaElement>('toolWordInput')?.addEventListener('input', calculateWordStats);
  byId<HTMLElement>('encodeBase64Btn')?.addEventListener('click', encodeBase64);
  byId<HTMLElement>('decodeBase64Btn')?.addEventListener('click', decodeBase64);

  // Pricing toggle
  byId<HTMLElement>('btn-monthly')?.addEventListener('click', () => toggleBilling('monthly'));
  byId<HTMLElement>('btn-yearly')?.addEventListener('click', () => toggleBilling('yearly'));

  // Support form
  byId<HTMLFormElement>('supportForm')?.addEventListener('submit', handleSupportSubmit);

  // Social footer placeholders (prevent # scroll jump)
  document.querySelectorAll<HTMLAnchorElement>('[data-social-link]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const name = link.dataset.socialLink || 'Community';
      showToast(`${name} link coming soon.`);
    });
  });

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    byId<HTMLElement>('pwaInstallBtn')?.classList.remove('hidden');
  });
  byId<HTMLElement>('pwaInstallBtn')?.addEventListener('click', installPwaApp);

  // Initial state
  renderInitialHistory();
  updateLineNumbers();
}
