import '../theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp';
import { ConnectionStatus } from '../ConnectionStatus';
import '../index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionStatus />
    <AdminApp />
  </StrictMode>,
);
