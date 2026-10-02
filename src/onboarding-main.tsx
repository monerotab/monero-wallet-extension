import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
import '@fontsource/roboto/latin-700.css';
import Onboarding from './Onboarding';
import { applyTheme } from './lib/theme';
import './onboarding.css';

// The theme preference is shared with the wallet popup. Apply it before the first
// render so there is no flash of the wrong theme (the CSP allows no inline script).
applyTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Onboarding /></React.StrictMode>);
