import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import App from './App';
import './style.css';
import './shelf-shell.css';
import './shelf-finder.css';
import './shelf-menu.css';
import './shelf-settings.css';
import './shelf-form.css';
import './shelf-button.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
