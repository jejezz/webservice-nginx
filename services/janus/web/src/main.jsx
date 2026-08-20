import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// vite base(/janus/dashboard/)를 라우터 basename으로 사용한다.
// 서비스 기준으로는 /dashboard가 웹 루트가 된다.
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
