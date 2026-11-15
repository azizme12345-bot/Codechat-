import './index.css';
import { initChatCode } from './chatcode.ts';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initChatCode);
} else {
  initChatCode();
}
