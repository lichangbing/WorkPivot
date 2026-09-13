import './theme';
/** React 入口：挂载 App（T1-01 脚手架）。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ConnectionStatus } from './ConnectionStatus';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionStatus />
    <App />
  </StrictMode>,
);
