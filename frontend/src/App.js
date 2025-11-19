import React, { useState, useEffect, createContext, useContext } from 'react';
import axios from 'axios';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';

const STORAGE_KEY = 'myagent_conversations_v1';
const THEME_KEY = 'myagent_theme';
const AUTH_TOKEN_KEY = 'myagent_auth_token';

const ThemeContext = createContext();

const themes = {
  dark: {
    background: '#0a0e27',
    text: '#e8e8e8',
    secondaryText: '#a0a0a0',
    border: '#1a1f3a',
    sidebar: '#0f1426',
    messageUser: '#1a3a52',
    messageAssistant: '#1a1f2e',
    selected: '#1f2744',
    inputBorder: '#2a3050',
    codeBackground: '#0d1117',
    codeBorder: '#2a3050',
    codeText: '#e8e8e8',
  }
};

function ThemeProvider({ children }) {
  const theme = themes.dark;

  return (
    <ThemeContext.Provider value={{ theme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// Component to render message content with code blocks
function MessageContent({ content, theme }) {
  const [copied, setCopied] = useState(null);

  const copyToClipboard = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopied(index);
    setTimeout(() => setCopied(null), 2000);
  };

  // Parse content for code blocks (```language\ncode```)
  const parseContent = (text) => {
    const parts = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.slice(lastIndex, match.index)
        });
      }

      // Add code block
      parts.push({
        type: 'code',
        language: match[1] || 'text',
        content: match[2].trim()
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push({
        type: 'text',
        content: text.slice(lastIndex)
      });
    }

    return parts.length > 0 ? parts : [{ type: 'text', content: text }];
  };

  const parts = parseContent(content);

  return (
    <div>
      {parts.map((part, index) => {
        if (part.type === 'code') {
          return (
            <div
              key={index}
              style={{
                marginTop: 8,
                marginBottom: 8,
                borderRadius: 6,
                border: `1px solid ${theme.codeBorder}`,
                overflow: 'hidden'
              }}
            >
              {/* Code header */}
              <div
                style={{
                  background: theme.codeBorder,
                  padding: '6px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 12,
                  color: theme.secondaryText
                }}
              >
                <span>{part.language}</span>
                <button
                  onClick={() => copyToClipboard(part.content, index)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                    border: 'none',
                    borderRadius: 4,
                    background: theme.background,
                    color: theme.text
                  }}
                >
                  {copied === index ? '✓ Copiado' : 'Copiar'}
                </button>
              </div>
              {/* Code content */}
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  background: theme.codeBackground,
                  color: theme.codeText,
                  overflow: 'auto',
                  fontSize: 13,
                  fontFamily: 'monospace',
                  lineHeight: 1.5
                }}
              >
                <code>{part.content}</code>
              </pre>
            </div>
          );
        } else {
          // Render normal text with line breaks preserved
          return (
            <div key={index} style={{ whiteSpace: 'pre-wrap' }}>
              {part.content}
            </div>
          );
        }
      })}
    </div>
  );
}

function App() {
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenEstimate, setTokenEstimate] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY));
  const [user, setUser] = useState(null);
  const { theme } = useContext(ThemeContext);

  useEffect(() => {
    if (authToken) {
      try {
        const decoded = jwtDecode(authToken);
        setUser(decoded);
      } catch (e) {
        console.error('Invalid token', e);
        logout();
      }
    }
  }, [authToken]);

  useEffect(() => {
    const interceptor = axios.interceptors.request.use((config) => {
      if (authToken) {
        config.headers.Authorization = `Bearer ${authToken}`;
      }
      return config;
    }, (error) => Promise.reject(error));

    return () => axios.interceptors.request.eject(interceptor);
  }, [authToken]);

  useEffect(() => {
    if (authToken) {
      const fetchConvs = async () => {
        try {
          const resp = await axios.get('http://localhost:8000/conversations');
          if (Array.isArray(resp.data)) {
            const mapped = resp.data.map((c) => ({ id: c.id, title: c.title, messages: [] }));
            setConversations(mapped);
            if (mapped.length > 0) setSelectedId(mapped[0].id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped));
          }
        } catch (e) {
          console.warn('Could not fetch conversations from backend', e);
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              setConversations(parsed);
              if (parsed.length > 0) setSelectedId(parsed[0].id);
            } catch (err) {
              console.error('Failed to parse local conversations', err);
            }
          }
        }
      };
      fetchConvs();
    }
  }, [authToken]);

  const persist = (next) => {
    setConversations(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.error('Failed to save conversations', e);
    }
  };

  const handleLogin = async (response) => {
    try {
      const resp = await axios.post('http://localhost:8000/auth/google', {
        id_token: response.credential,
      });
      const token = resp.data.access_token;
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      setAuthToken(token);
    } catch (e) {
      console.error('Login failed', e);
    }
  };

  const logout = () => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
    setConversations([]);
    setSelectedId(null);
  };

  const createConversation = async () => {
    try {
      const resp = await axios.post('http://localhost:8000/conversations', { 
        title: `Conversa ${conversations.length + 1}` 
      });
      const conv = resp.data;
      const next = [{ id: conv.id, title: conv.title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(conv.id);
    } catch (e) {
      console.warn('Failed to create conversation on backend', e);
      const id = Date.now().toString();
      const title = `Conversa ${conversations.length + 1}`;
      const next = [{ id, title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(id);
    }
  };

  const selectConversation = async (id) => {
    setSelectedId(id);
    try {
      const resp = await axios.get(`http://localhost:8000/conversations/${id}`);
      if (resp.data && resp.data.messages) {
        const next = conversations.map((c) => (c.id === id ? { ...c, messages: resp.data.messages.map(m => ({ ...m, ts: new Date(m.created_at).getTime() })) } : c));
        persist(next);
      }
    } catch (e) {
      console.error('Failed to fetch messages', e);
    }
  };

  const startEditing = (id, currentTitle) => {
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const saveEdit = async (id) => {
    if (!editingTitle.trim()) return;
    try {
      await axios.patch(`http://localhost:8000/conversations/${id}`, { title: editingTitle });
      const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
      persist(next);
    } catch (e) {
      console.error('Failed to update title', e);
      const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
      persist(next);
    }
    setEditingId(null);
  };

  const deleteConversation = async (id) => {
    if (!window.confirm('Tem certeza que deseja excluir esta conversa?')) return;
    try {
      await axios.delete(`http://localhost:8000/conversations/${id}`);
      const next = conversations.filter((c) => c.id !== id);
      persist(next);
      if (selectedId === id) {
        setSelectedId(next.length > 0 ? next[0].id : null);
      }
    } catch (e) {
      console.error('Failed to delete conversation', e);
    }
  };

  const sendMessage = async () => {
    if (!input || !selectedId) return;
    const userMsg = { role: 'user', content: input, ts: Date.now() };

    const updated = conversations.map((c) =>
      c.id === selectedId ? { ...c, messages: [...(c.messages || []), userMsg] } : c
    );
    persist(updated);
    setInput('');
    setLoading(true);

    try {
      const resp = await axios.post('http://localhost:8000/chat', {
        message: userMsg.content,
        conversation_id: selectedId,
      });

      const assistantText = resp.data.reply || 'No reply';
      const assistantMsg = { role: 'assistant', content: assistantText, ts: Date.now() };

      const convId = resp.data.conversation_id || selectedId;
      
      let withAssistant = updated.map((c) =>
        c.id === selectedId || c.id === convId ? { ...c, messages: [...c.messages, assistantMsg] } : c
      );

      if (resp.data.title && resp.data.title !== conversations.find(c => c.id === selectedId).title) {
        withAssistant = withAssistant.map((c) =>
          c.id === convId ? { ...c, title: resp.data.title } : c
        );
      }

      persist(withAssistant);
      if (convId !== selectedId) setSelectedId(convId);
    } catch (err) {
      console.error('Error in chat', err);
      const errMsg = { role: 'assistant', content: 'Erro: não foi possível obter resposta.', ts: Date.now() };
      const withError = updated.map((c) =>
        c.id === selectedId ? { ...c, messages: [...c.messages, errMsg] } : c
      );
      persist(withError);
    } finally {
      setLoading(false);
    }
  };

  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  if (!authToken) {
    return (
      <div style={{
        display: 'flex',
        height: '100vh',
        justifyContent: 'center',
        alignItems: 'center',
        background: theme.background,
        flexDirection: 'column',
        gap: 60
      }}>
        <h1 style={{
          fontSize: 120,
          fontWeight: 900,
          margin: 0,
          color: theme.text,
          textAlign: 'center',
          lineHeight: 1,
          letterSpacing: -2
        }}>
          Meu amigo agente
        </h1>
        <GoogleLogin
          onSuccess={handleLogin}
          onError={() => console.log('Login Failed')}
          useOneTap
        />
      </div>
    );
  }

  return (
    <div style={{ 
      display: 'flex', 
      height: '100vh', 
      fontFamily: 'Arial, sans-serif',
      background: theme.background,
      color: theme.text,
      flexDirection: 'column'
    }}>
      {/* Banner */}
      <div style={{
        background: 'linear-gradient(135deg, #1a3a52 0%, #0f1426 100%)',
        padding: '20px 24px',
        borderBottom: `1px solid ${theme.border}`,
        textAlign: 'center'
      }}>
        <h1 style={{
          margin: 0,
          fontSize: 48,
          fontWeight: 900,
          color: theme.text,
          letterSpacing: -1
        }}>
          Meu amigo agente
        </h1>
      </div>

      <div style={{ display: 'flex', flex: 1 }}>
        {/* Left sidebar: conversations */}
        <div style={{ 
          width: 280, 
          borderRight: `1px solid ${theme.border}`, 
          padding: 12, 
          boxSizing: 'border-box',
          background: theme.sidebar
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            marginBottom: 12 
          }}>
            <h3 style={{ margin: 0 }}>Conversas</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button 
                onClick={createConversation}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: `1px solid ${theme.border}`,
                  background: theme.background,
                  color: theme.text,
                  fontSize: '16px',
                  fontWeight: 'bold'
                }}
              >
                +
              </button>
              <button 
                onClick={logout}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: `1px solid ${theme.border}`,
                  background: theme.background,
                  color: theme.text
                }}
              >
                Logout
              </button>
            </div>
          </div>

          <div style={{ overflowY: 'auto', height: 'calc(100% - 48px)' }}>
            {conversations.map((c) => (
              <div
                key={c.id}
                style={{
                  padding: 8,
                  marginBottom: 8,
                  borderRadius: 6,
                  background: c.id === selectedId ? theme.selected : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <div onClick={() => selectConversation(c.id)} style={{ flex: 1, cursor: 'pointer' }}>
                  {editingId === c.id ? (
                    <input
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => saveEdit(c.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(c.id); }}
                      style={{
                        width: '100%',
                        padding: 4,
                        borderRadius: 4,
                        border: `1px solid ${theme.inputBorder}`,
                        background: theme.background,
                        color: theme.text
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: theme.secondaryText }}>
                        {(c.messages && c.messages.length) || 0} mensagens
                      </div>
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => startEditing(c.id, c.title)}
                    style={{
                      padding: '4px',
                      border: 'none',
                      background: 'transparent',
                      color: theme.text,
                      cursor: 'pointer'
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    onClick={() => deleteConversation(c.id)}
                    style={{
                      padding: '4px',
                      border: 'none',
                      background: 'transparent',
                      color: theme.text,
                      cursor: 'pointer'
                    }}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right panel: chat */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 16, borderBottom: `1px solid ${theme.border}` }}>
            <h2 style={{ margin: 0 }}>
              {selectedConv ? selectedConv.title : 'Selecione uma conversa'}
            </h2>
          </div>

          <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
            {selectedConv && selectedConv.messages && selectedConv.messages.length > 0 ? (
              selectedConv.messages.map((m, idx) => (
                <div key={idx} style={{ marginBottom: 16 }}>
                  <div style={{ 
                    fontSize: 12, 
                    color: theme.secondaryText, 
                    marginBottom: 4,
                    fontWeight: 600
                  }}>
                    {m.role === 'user' ? 'Você' : 'Assistente'}
                  </div>
                  <div style={{ 
                    padding: 12, 
                    background: m.role === 'user' ? theme.messageUser : theme.messageAssistant, 
                    borderRadius: 8,
                    color: theme.text
                  }}>
                    <MessageContent content={m.content} theme={theme} />
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: theme.secondaryText }}>
                Nenhuma mensagem ainda. Comece uma conversa.
              </div>
            )}
          </div>

          <div style={{ 
            padding: 12, 
            borderTop: `1px solid ${theme.border}`, 
            display: 'flex', 
            gap: 8, 
            alignItems: 'flex-end' 
          }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setTokenEstimate(Math.ceil(e.target.value.length / 4));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={loading ? 'Enviando...' : 'Digite sua mensagem... (Shift+Enter para nova linha)'}
                style={{ 
                  width: '100%', 
                  minHeight: 60, 
                  resize: 'vertical', 
                  padding: 10, 
                  borderRadius: 6, 
                  border: `1px solid ${theme.inputBorder}`,
                  background: theme.background,
                  color: theme.text,
                  fontFamily: 'inherit'
                }}
                disabled={loading || !selectedId}
                maxLength={20000}
              />
              <div style={{ fontSize: 12, color: tokenEstimate > 4000 ? 'red' : theme.secondaryText }}>
                Est. tokens: {tokenEstimate} {tokenEstimate > 4000 ? '(alto — pode exceder limites)' : ''}
              </div>
            </div>
            <button 
              onClick={sendMessage} 
              disabled={loading || !input || !selectedId} 
              style={{ 
                padding: '10px 16px', 
                minWidth: 90,
                borderRadius: 6,
                cursor: loading || !input ? 'not-allowed' : 'pointer',
                border: 'none',
                background: loading || !input ? theme.border : '#0066cc',
                color: '#ffffff',
                fontWeight: 600
              }}
            >
              {loading ? '...' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppWithTheme() {
  return (
    <GoogleOAuthProvider clientId={process.env.REACT_APP_GOOGLE_CLIENT_ID}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </GoogleOAuthProvider>
  );
}

export default AppWithTheme;