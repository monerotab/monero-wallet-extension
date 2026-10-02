import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
import '@fontsource/roboto/latin-700.css';
import App from './App';
import { applyTheme } from './lib/theme';
import './gui.css';

applyTheme();
if (new URLSearchParams(location.search).has('popup')) document.documentElement.classList.add('extension-popup');
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
