type PageTab = 'home' | 'chat' | 'code' | 'tools' | 'pricing' | 'about' | 'help';
type CodeTab = 'html' | 'css' | 'js';
type BillingMode = 'monthly' | 'yearly';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface ProjectSummary {
  name: string;
  files: string[];
  important: string[];
  total: number;
  skipped: number;
}

interface JSZipEntryLike {
  name: string;
  dir: boolean;
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

declare global {
  interface Window {
    JSZip?: JSZipStaticLike;
  }
}

const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024; // 50 MB compressed archive limit
const MAX_ZIP_ENTRIES = 5000;
const MAX_SINGLE_UNCOMPRESSED_BYTES = 15 * 1024 * 1024; // 15 MB per file
const MAX_TOTAL_UNCOMPRESSED_BYTES = 150 * 1024 * 1024; // 150 MB extracted total

const CHATCODE_IGNORE = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|vendor)(\/|$)/i;
const CHATCODE_IMPORTANT =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|vite\.config\.[^/]+|next\.config\.[^/]+|tsconfig\.json|jsconfig\.json|README[^/]*|index\.html|\.env\.example|wrangler\.toml|vercel\.json)$/i;

let currentTab: PageTab = 'home';
let activeCodeTab: CodeTab = 'html';
let billingMode: BillingMode = 'monthly';
let isVoiceActive = false;
let selectedFile: string | null = null;
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let toastTimer: number | null = null;

let chatCodeProject: ProjectSummary = {
  name: '',
  files: [],
  important: [],
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
    { tab: 'chat', label: '💬 AI Chat Assistant & Project Analyzer', keywords: 'chat ai assistant prompt zip review' },
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
  submitChatMessage();
}

function handleFileSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  selectedFile = file.name;
  const statusEl = byId<HTMLElement>('fileStatus');
  if (statusEl) {
    statusEl.textContent = `Attached: ${file.name}`;
  }
  showToast(`File attached: ${file.name}`);
}

function toggleVoiceMic(): void {
  isVoiceActive = !isVoiceActive;
  const micBtn = byId<HTMLElement>('micBtn');
  if (!micBtn) return;

  if (isVoiceActive) {
    micBtn.classList.add('text-brand-orange', 'animate-pulse');
    showToast('Voice listening active...');
  } else {
    micBtn.classList.remove('text-brand-orange', 'animate-pulse');
    showToast('Voice input stopped.');
  }
}

function createCodeCardElement(codeSnippet: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'mt-3 bg-slate-900 text-slate-100 rounded-xl p-3 code-font text-xs overflow-x-auto border border-slate-800';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between border-b border-slate-800 pb-2 mb-2 text-[11px] text-slate-400';

  const label = document.createElement('span');
  label.textContent = 'HTML Component';

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
    transferToWorkspace(codeSnippet);
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

function appendMessage(
  sender: 'user' | 'ai',
  buildBody: (paragraphHost: HTMLElement) => void,
  codeSnippet: string | null = null
): void {
  const container = byId<HTMLElement>('chatMessages');
  if (!container) return;

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
    body.className = 'whitespace-pre-wrap break-words';
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

    if (codeSnippet) {
      bubble.appendChild(createCodeCardElement(codeSnippet));
    }

    msgDiv.append(avatar, bubble);
  }

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

function generateAiResponse(userText: string): void {
  const lower = userText.toLowerCase();

  if (lower.includes('todo') || lower.includes('plan')) {
    const code = `<div style="padding:20px; background:#fff; border-radius:12px;">\n  <h3>My Todo List</h3>\n  <input type="text" placeholder="Add task..." style="padding:8px; border:1px solid #ccc; border-radius:6px;">\n  <button style="background:#0D5CFF; color:#fff; padding:8px 15px; border:none; border-radius:6px;">Add</button>\n</div>`;

    appendMessage(
      'ai',
      (host) => {
        const intro = document.createElement('p');
        intro.textContent = 'Here is a structured plan for your web app project:';

        const steps = document.createElement('div');
        steps.className = 'space-y-1';
        const stepList: Array<[string, string]> = [
          ['Step 1:', ' Define layout with title, input bar, and clear button.'],
          ['Step 2:', ' Add CSS card styling and interactive hover states.'],
          ['Step 3:', ' Implement JavaScript array list management.'],
        ];
        stepList.forEach(([title, desc]) => {
          const line = document.createElement('p');
          const strong = document.createElement('strong');
          strong.textContent = title;
          line.append(strong, document.createTextNode(desc));
          steps.appendChild(line);
        });

        const outro = document.createElement('p');
        outro.textContent = 'I generated an initial HTML structure for you:';

        host.append(intro, steps, outro);
      },
      code
    );
  } else if (lower.includes('landing') || lower.includes('component')) {
    const code = `<section style="text-align:center; padding:40px; background:#E8F0FF; border-radius:16px;">\n  <h1 style="color:#0D5CFF; font-size:28px;">Build Faster Today</h1>\n  <p style="color:#475569;">The smart platform for developers.</p>\n  <button style="background:#FF7A00; color:white; padding:12px 24px; border:none; border-radius:8px; font-weight:bold;">Get Started Free</button>\n</section>`;

    appendMessage(
      'ai',
      (host) => {
        const p = document.createElement('p');
        p.textContent = 'Great choice! Here is a clean hero component structure designed with high contrast CTA buttons:';
        host.appendChild(p);
      },
      code
    );
  } else {
    appendMessage('ai', (host) => {
      const p1 = document.createElement('p');
      const italic = document.createElement('em');
      italic.textContent = userText;
      p1.append(document.createTextNode('I analyzed your query: "'), italic, document.createTextNode('".'));

      const p2 = document.createElement('p');
      p2.textContent =
        "Let's plan out the implementation together. Would you like me to draft the HTML structure or provide JavaScript logic first?";

      host.append(p1, p2);
    });
  }
}

function submitChatMessage(): void {
  const input = byId<HTMLInputElement>('chatInput');
  if (!input) return;

  const userMsg = input.value.trim();
  if (!userMsg) return;

  appendMessage('user', (host) => {
    const p = document.createElement('p');
    p.textContent = userMsg;
    host.appendChild(p);
  });

  input.value = '';
  const fileStatus = byId<HTMLElement>('fileStatus');
  if (fileStatus) fileStatus.textContent = '';
  selectedFile = null;

  window.setTimeout(() => {
    generateAiResponse(userMsg);
  }, 700);
}

function handleChatSubmit(event: Event): void {
  event.preventDefault();
  submitChatMessage();
}

function transferToWorkspace(codeSnippet: string): void {
  const htmlEditor = byId<HTMLTextAreaElement>('code-html');
  if (htmlEditor) {
    htmlEditor.value = codeSnippet;
  }
  selectCodeTab('html');
  switchTab('code');
  showToast('Code transferred to Workspace!');
}

function startNewChat(): void {
  const container = byId<HTMLElement>('chatMessages');
  if (!container) return;

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
// DEVELOPER TOOLS FUNCTIONS
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
// PROJECT ZIP INSPECTOR (WITH HARDENED CHECKS)
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

async function inspectProjectZip(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const status = byId<HTMLElement>('projectZipStatus');
  const details = byId<HTMLElement>('projectZipDetails');
  const promptBtn = byId<HTMLElement>('projectPromptBtn');
  if (!status || !details || !promptBtn) return;

  promptBtn.classList.add('hidden');
  details.classList.add('hidden');
  details.replaceChildren();

  if (!/\.zip$/i.test(file.name)) {
    status.textContent = 'Please select a ZIP file.';
    input.value = '';
    return;
  }

  if (file.size > MAX_ZIP_FILE_BYTES) {
    status.textContent = 'ZIP is larger than 50 MB. Please upload a smaller project archive.';
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
    const safeEntries: JSZipEntryLike[] = [];

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

      const normalized = entry.name.replace(/\\/g, '/');
      if (CHATCODE_IGNORE.test(normalized)) {
        continue;
      }
      if (normalized.split('/').some((part) => part.startsWith('.') && !['.github'].includes(part))) {
        continue;
      }

      safeEntries.push(entry);
    }

    if (oversizedEntryFound) {
      status.textContent = 'ZIP extracted size exceeds safety limits (15 MB per file or 150 MB total).';
      input.value = '';
      return;
    }

    const important = safeEntries.filter((entry) => CHATCODE_IMPORTANT.test(entry.name)).map((entry) => entry.name);
    const skippedCount = fileEntries.length - safeEntries.length;

    chatCodeProject = {
      name: file.name,
      files: safeEntries.slice(0, 250).map((entry) => entry.name),
      important,
      total: safeEntries.length,
      skipped: skippedCount,
    };

    status.textContent = 'ZIP structure loaded. This is a file-list inspection, not an AI code audit yet.';

    const addDetailRow = (label: string, value: string): void => {
      const row = document.createElement('div');
      const strong = document.createElement('b');
      strong.textContent = label;
      row.append(strong, document.createTextNode(` ${value}`));
      details.appendChild(row);
    };

    addDetailRow('Project:', file.name);
    addDetailRow('Project files:', String(safeEntries.length));
    addDetailRow('Ignored / unsafe paths:', String(skippedCount));
    addDetailRow(
      'Key files detected:',
      important.length ? important.slice(0, 8).join(', ') : 'Not detected in the first-level scan'
    );

    const note = document.createElement('div');
    note.className = 'mt-1 text-slate-500';
    note.textContent = 'Showing up to 250 file paths. Large dependency/build folders are excluded.';
    details.appendChild(note);

    details.classList.remove('hidden');
    promptBtn.classList.remove('hidden');
    showToast('Project ZIP structure inspected');
  } catch {
    status.textContent = 'Could not read this ZIP. Please check that the archive is valid.';
  }

  input.value = '';
}

function buildProjectReviewPrompt(): string {
  return `You are ChatCode's careful senior codebase analyst. Review the uploaded repository ZIP itself; do not guess or claim to have read files you cannot access. First report exact file coverage and files not inspected. Ignore node_modules, .git, build outputs and generated files. Inspect project entry points, package/config files, routes, components, API calls, environment-variable usage, security, responsive UI and deployment configuration. For every finding cite exact file paths and line numbers when available. Separate confirmed bugs from risks and suggestions. Do not modify code yet. Produce: (1) architecture map, (2) working vs demo-only features, (3) bugs with evidence, (4) security/deployment issues, (5) prioritized plan in small steps. Ask for approval before each implementation step. Preserve existing UI, colors, logo, layout and working features unless explicitly approved. Never expose API keys; use server-side environment variables only.\n\nProject archive: ${chatCodeProject.name}\nFile count discovered by browser ZIP listing: ${chatCodeProject.total}\nImportant files detected: ${chatCodeProject.important.join(', ') || 'None detected'}\nVisible file paths (first 250):\n${chatCodeProject.files.join('\n')}`;
}

function copyProjectReviewPrompt(): void {
  void copyTextToClipboard(buildProjectReviewPrompt());
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
  byId<HTMLInputElement>('chatFileInput')?.addEventListener('change', handleFileSelected);
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
