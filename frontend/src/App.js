import React, { useState, useEffect, createContext, useContext, useRef } from 'react';
import axios from 'axios';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';

const STORAGE_KEY = 'myagent_conversations_v1';
const THEME_KEY = 'myagent_theme';
const AUTH_TOKEN_KEY = 'myagent_auth_token';

const ThemeContext = createContext();

const themes = {
  light: {
    background: '#ffffff',
    text: '#000000',
    secondaryText: '#666666',
    border: '#eeeeee',
    sidebar: '#ffffff',
    messageUser: '#e6f7ff',
    messageAssistant: '#f6f6f6',
    selected: '#f0f0f0',
    inputBorder: '#dddddd',
    codeBackground: '#f5f5f5',
    codeBorder: '#e0e0e0',
    codeText: '#1a1a1a',
  },
  dark: {
    background: '#0b0f0a',
    text: '#d6ffd6',
    secondaryText: '#9fb99f',
    border: '#143214',
    sidebar: '#071007',
    messageUser: '#014f01',
    messageAssistant: '#0b1a0b',
    selected: '#092209',
    inputBorder: '#143214',
    codeBackground: '#071007',
    codeBorder: '#0b2b0b',
    codeText: '#d4ffd4',
  }
};

function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved ? JSON.parse(saved) : true;
    } catch (e) {
      console.error('Erro ao ler tema', e);
      return true;
    }
  });

  const toggleTheme = () => {
    const newTheme = !isDark;
    setIsDark(newTheme);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(THEME_KEY, JSON.stringify(newTheme));
      } catch (e) {
        console.error('Erro ao salvar tema', e);
      }
    }
  };

  const theme = isDark ? themes.dark : themes.light;

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>
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

  const parseContent = (text) => {
    const parts = [];
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.slice(lastIndex, match.index)
        });
      }

      parts.push({
        type: 'code',
        language: match[1] || 'text',
        content: match[2].trim()
      });

      lastIndex = match.index + match[0].length;
    }

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
  const [authToken, setAuthToken] = useState(() => {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(AUTH_TOKEN_KEY);
    } catch (e) {
      return null;
    }
  });
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const messagesEndRef = useRef(null);
  const interceptorRef = useRef(null);
  const { theme, isDark, toggleTheme } = useContext(ThemeContext);

  // Hook do Google Login
  const googleLogin = useGoogleLogin({
    onSuccess: async (response) => {
      try {
        setError(null);
        const resp = await axios.post('http://localhost:8000/auth/google', {
          id_token: response.access_token,
        }, {
          timeout: 5000
        });

        if (!resp.data || !resp.data.access_token) {
          throw new Error('Resposta inválida do servidor');
        }

        const token = resp.data.access_token;
        if (typeof window !== 'undefined') {
          localStorage.setItem(AUTH_TOKEN_KEY, token);
        }
        setAuthToken(token);
      } catch (e) {
        console.error('Erro no login:', e.message);
        setError(`Erro no login: ${e.message}`);
      }
    },
    onError: () => {
      setError('Falha ao fazer login com Google');
      console.error('Google login failed');
    }
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversations, selectedId]);

  useEffect(() => {
    const validateToken = () => {
      if (authToken) {
        try {
          const decoded = jwtDecode(authToken);
          if (decoded.exp && decoded.exp * 1000 < Date.now()) {
            console.warn('Token expirado');
            logout();
            return;
          }
          setUser(decoded);
          setIsInitializing(false);
        } catch (e) {
          console.error('Token inválido:', e);
          logout();
        }
      } else if (process.env.NODE_ENV === 'development') {
        const devLogin = async () => {
          try {
            console.log('Tentando auto-login de desenvolvimento...');
            const resp = await axios.post('http://localhost:8000/auth/dev');
            const token = resp.data.access_token;
            if (typeof window !== 'undefined') {
              localStorage.setItem(AUTH_TOKEN_KEY, token);
            }
            setAuthToken(token);
          } catch (e) {
            console.warn('Auto-login falhou:', e.message);
            setIsInitializing(false);
          }
        };
        devLogin();
      } else {
        setIsInitializing(false);
      }
    };

    validateToken();
  }, []);

  useEffect(() => {
    if (authToken && !interceptorRef.current) {
      interceptorRef.current = axios.interceptors.request.use(
        (config) => {
          config.headers.Authorization = `Bearer ${authToken}`;
          return config;
        },
        (error) => Promise.reject(error)
      );
    }

    return () => {
      if (interceptorRef.current !== null) {
        axios.interceptors.request.eject(interceptorRef.current);
        interceptorRef.current = null;
      }
    };
  }, [authToken]);

  useEffect(() => {
    if (authToken) {
      const fetchConvs = async () => {
        try {
          const resp = await axios.get('http://localhost:8000/conversations', {
            timeout: 5000
          });
          if (Array.isArray(resp.data)) {
            const mapped = resp.data.map((c) => ({ id: c.id, title: c.title, messages: [] }));
            setConversations(mapped);
            if (mapped.length > 0) setSelectedId(mapped[0].id);
            if (typeof window !== 'undefined') {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(mapped));
            }
            setError(null);
          }
        } catch (e) {
          console.warn('Não foi possível buscar conversas:', e.message);
          setError('Usando dados locais');

          if (typeof window !== 'undefined') {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
              try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                  setConversations(parsed);
                  if (parsed.length > 0) setSelectedId(parsed[0].id);
                }
              } catch (err) {
                console.error('Erro ao ler conversas locais:', err);
              }
            }
          }
        }
      };
      fetchConvs();
    }
  }, [authToken]);

  const persist = (next) => {
    setConversations(next);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        console.error('Erro ao salvar conversas:', e);
      }
    }
  };

  const logout = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
    setAuthToken(null);
    setUser(null);
    setConversations([]);
    setSelectedId(null);
    setError(null);
  };

  const createConversation = async () => {
    try {
      setError(null);
      const resp = await axios.post('http://localhost:8000/conversations', {
        title: `Conversa ${conversations.length + 1}`
      }, {
        timeout: 5000
      });

      if (!resp.data || !resp.data.id) {
        throw new Error('ID de conversa não recebido');
      }

      const conv = resp.data;
      const next = [{ id: conv.id, title: conv.title, messages: [] }, ...conversations];
      persist(next);
      setSelectedId(conv.id);
    } catch (e) {
      console.warn('Erro ao criar conversa:', e.message);
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
      const resp = await axios.get(`http://localhost:8000/conversations/${id}`, {
        timeout: 5000
      });

      if (resp.data && Array.isArray(resp.data.messages)) {
        const next = conversations.map((c) =>
          c.id === id
            ? {
                ...c,
                messages: resp.data.messages.map(m => ({
                  ...m,
                  ts: m.created_at ? new Date(m.created_at).getTime() : Date.now()
                }))
              }
            : c
        );
        persist(next);
      }
    } catch (e) {
      console.error('Erro ao buscar mensagens:', e.message);
    }
  };

  const startEditing = (id, currentTitle) => {
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const saveEdit = async (id) => {
    if (!editingTitle.trim()) return;
    try {
      await axios.patch(`http://localhost:8000/conversations/${id}`, {
        title: editingTitle
      }, {
        timeout: 5000
      });
    } catch (e) {
      console.error('Erro ao atualizar:', e.message);
    } finally {
      const next = conversations.map((c) =>
        c.id === id ? { ...c, title: editingTitle } : c
      );
      persist(next);
      setEditingId(null);
    }
  };

  const deleteConversation = async (id) => {
    if (!window.confirm('Tem certeza que deseja excluir?')) return;
    try {
      await axios.delete(`http://localhost:8000/conversations/${id}`, {
        timeout: 5000
      });
    } catch (e) {
      console.error('Erro ao deletar:', e.message);
    } finally {
      const next = conversations.filter((c) => c.id !== id);
      persist(next);
      if (selectedId === id) {
        setSelectedId(next.length > 0 ? next[0].id : null);
      }
    }
  };

  const validateInput = (text) => {
    return text.trim().length > 0 && text.length <= 20000;
  };

  const sendMessage = async () => {
    if (!validateInput(input) || !selectedId) {
      if (!selectedId) {
        setError('Selecione uma conversa primeiro');
      }
      return;
    }

    const userMsg = { role: 'user', content: input, ts: Date.now() };
    const currentInput = input;
    setInput('');
    setLoading(true);
    setError(null);

    try {
      let tempConversations = conversations.map((c) =>
        c.id === selectedId ? { ...c, messages: [...(c.messages || []), userMsg] } : c
      );
      persist(tempConversations);

      const resp = await axios.post('http://localhost:8000/chat', {
        message: currentInput,
        conversation_id: selectedId,
      }, {
        timeout: 30000
      });

      if (!resp.data) {
        throw new Error('Resposta vazia');
      }

      const assistantText = resp.data.reply || 'Sem resposta';
      const assistantMsg = { role: 'assistant', content: assistantText, ts: Date.now() };
      const convId = resp.data.conversation_id || selectedId;
      const convTitle = resp.data.title;

      const updated = tempConversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              title: convTitle || c.title,
              messages: [...c.messages, assistantMsg],
            }
          : c
      );
      persist(updated);

      if (!selectedId || convId !== selectedId) {
        setSelectedId(convId);
      }
    } catch (err) {
      console.error('Erro:', err.message);
      const errorMsg = {
        role: 'assistant',
        content: `Erro: ${err.message}`,
        ts: Date.now()
      };

      const withError = conversations.map((c) =>
        c.id === selectedId ? { ...c, messages: [...(c.messages || []), userMsg, errorMsg] } : c
      );
      persist(withError);
      setError(`Erro: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  if (!authToken || isInitializing) {
    return (
      <div style={{
        display: 'flex',
        height: '100vh',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: '#000',
        color: '#fff',
        gap: 40,
        fontFamily: '"Segoe UI", sans-serif'
      }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{
            fontSize: 82,
            fontWeight: 900,
            margin: 0,
            background: 'linear-gradient(90deg, #1DB954, #18e66e)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}>
            MyAgent
          </h1>
          <p style={{ fontSize: 28, margin: '20px 0 0', opacity: 0.9 }}>
            Bem vindo! ✋
          </p>
          {isInitializing && (
            <p style={{ fontSize: 16, margin: '20px 0 0', opacity: 0.7 }}>
              Carregando...
            </p>
          )}
        </div>

        {!isInitializing && (
          <button
            onClick={() => googleLogin()}
            style={{
              padding: '18px 50px',
              background: '#fff',
              color: '#000',
              border: 'none',
              borderRadius: 50,
              fontSize: 20,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              boxShadow: '0 10px 30px rgba(29, 185, 84, 0.4)',
              transition: '0.3s'
            }}
            onMouseOver={e => e.currentTarget.style.transform = 'translateY(-4px)'}
            onMouseOut={e => e.currentTarget.style.transform = 'translateY(0)'}
          >
            <img src="https://upload.wikimedia.org/wikipedia/commons/5/53/Google_%22G%22_Logo.svg" width={30} alt="G" />
            Fazer Login com o Google
          </button>
        )}

        {error && (
          <div style={{ color: '#ff4444', fontSize: 14, textAlign: 'center' }}>
            {error}
          </div>
        )}

        <div style={{ position: 'absolute', bottom: 30, opacity: 0.5, fontSize: 14 }}>
          Clique no botão para fazer login
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      fontFamily: 'Arial, sans-serif',
      background: theme.background,
      color: theme.text
    }}>
      {/* Left sidebar */}
      <div style={{
        width: 280,
        borderRight: `1px solid ${theme.border}`,
        padding: 12,
        boxSizing: 'border-box',
        background: theme.sidebar,
        display: 'flex',
        flexDirection: 'column'
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
              onClick={toggleTheme}
              style={{
                padding: '6px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                border: `1px solid ${theme.border}`,
                background: theme.background,
                color: theme.text
              }}
            >
              {isDark ? '☀️' : '🌙'}
            </button>
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

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {conversations.length === 0 ? (
            <div style={{ color: theme.secondaryText, fontSize: 14 }}>
              Nenhuma conversa
            </div>
          ) : (
            conversations.map((c) => (
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
            ))
          )}
        </div>
      </div>

      {/* Right panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 16, borderBottom: `1px solid ${theme.border}` }}>
          <h2 style={{ margin: 0 }}>
            {selectedConv ? selectedConv.title : 'Selecione uma conversa'}
          </h2>
        </div>

        {error && (
          <div style={{
            padding: 12,
            background: '#ff4444',
            color: '#fff',
            fontSize: 14,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            {error}
            <button
              onClick={() => setError(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#fff',
                cursor: 'pointer'
              }}
            >
              ✕
            </button>
          </div>
        )}

        <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
          {selectedConv && selectedConv.messages && selectedConv.messages.length > 0 ? (
            <>
              {selectedConv.messages.map((m, idx) => (
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
              ))}
              <div ref={messagesEndRef} />
            </>
          ) : (
            <div style={{ color: theme.secondaryText }}>
              Nenhuma mensagem ainda
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
              placeholder={loading ? 'Enviando...' : 'Digite sua mensagem...'}
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
              disabled={loading || !selectedConv}
              maxLength={20000}
            />
            <div style={{ fontSize: 12, color: tokenEstimate > 4000 ? 'red' : theme.secondaryText }}>
              Est. tokens: {tokenEstimate}
            </div>
          </div>
          <button
            onClick={sendMessage}
            disabled={loading || !input || !selectedConv}
            style={{
              padding: '10px 16px',
              minWidth: 90,
              borderRadius: 6,
              cursor: loading || !input || !selectedConv ? 'not-allowed' : 'pointer',
              border: 'none',
              background: loading || !input || !selectedConv ? theme.border : '#0066cc',
              color: '#ffffff',
              fontWeight: 600
            }}
          >
            {loading ? '...' : 'Enviar'}
          </button>
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