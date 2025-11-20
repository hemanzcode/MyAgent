import React, { useState, useContext, createContext } from 'react';

const ThemeContext = createContext();

const themes = {
  matrix: {
    background: '#0a0e0a',
    text: '#00ff00',
    textGlow: '#00ff00',
    secondaryText: '#00cc00',
    border: '#004d00',
    sidebar: '#050805',
    messageUser: '#0d2d0d',
    messageAssistant: '#0a1a0a',
    selected: '#1a4d1a',
    inputBorder: '#004d00',
    codeBackground: '#050805',
    codeBorder: '#003300',
    codeText: '#00ff00',
    accent: '#00ff00'
  }
};

function ThemeProvider({ children }) {
  const theme = themes.matrix;
  return (
    <ThemeContext.Provider value={{ theme }}>
      {children}
    </ThemeContext.Provider>
  );
}

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
                borderRadius: 2,
                border: `1px solid ${theme.codeBorder}`,
                overflow: 'hidden',
                boxShadow: `0 0 10px rgba(0, 255, 0, 0.2)`
              }}
            >
              <div
                style={{
                  background: theme.codeBorder,
                  padding: '6px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 11,
                  color: theme.accent,
                  fontFamily: 'Courier New, monospace',
                  fontWeight: 'bold'
                }}
              >
                <span>$ {part.language}</span>
                <button
                  onClick={() => copyToClipboard(part.content, index)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 11,
                    cursor: 'pointer',
                    border: `1px solid ${theme.accent}`,
                    borderRadius: 2,
                    background: theme.background,
                    color: theme.accent,
                    fontFamily: 'Courier New, monospace',
                    fontWeight: 'bold',
                    textShadow: `0 0 5px ${theme.accent}`,
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.boxShadow = `0 0 10px rgba(0, 255, 0, 0.5)`;
                    e.target.style.background = theme.messageAssistant;
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.boxShadow = '';
                    e.target.style.background = theme.background;
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
                  fontSize: 12,
                  fontFamily: 'Courier New, monospace',
                  lineHeight: 1.6,
                  textShadow: `0 0 5px ${theme.codeText}`
                }}
              >
                <code>{part.content}</code>
              </pre>
            </div>
          );
        } else {
          return (
            <div key={index} style={{ whiteSpace: 'pre-wrap', fontFamily: 'Courier New, monospace' }}>
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
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const { theme } = useContext(ThemeContext);

  const persist = (next) => {
    setConversations(next);
  };

  const login = () => {
    setIsLoggedIn(true);
  };

  const logout = () => {
    setIsLoggedIn(false);
    setConversations([]);
    setSelectedId(null);
  };

  const createConversation = () => {
    const id = Date.now().toString();
    const title = `[ terminal-${conversations.length + 1} ]`;
    const next = [{ id, title, messages: [] }, ...conversations];
    persist(next);
    setSelectedId(id);
  };

  const selectConversation = (id) => {
    setSelectedId(id);
  };

  const startEditing = (id, currentTitle) => {
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const saveEdit = (id) => {
    if (!editingTitle.trim()) return;
    const next = conversations.map((c) => (c.id === id ? { ...c, title: editingTitle } : c));
    persist(next);
    setEditingId(null);
  };

  const deleteConversation = (id) => {
    if (!window.confirm('Deseja excluir?')) return;
    const next = conversations.filter((c) => c.id !== id);
    persist(next);
    if (selectedId === id) {
      setSelectedId(next.length > 0 ? next[0].id : null);
    }
  };

  const sendMessage = async () => {
    if (!input) return;
    const userMsg = { role: 'user', content: input, ts: Date.now() };

    let tempConversations = conversations;
    if (selectedId) {
      tempConversations = conversations.map((c) =>
        c.id === selectedId ? { ...c, messages: [...(c.messages || []), userMsg] } : c
      );
      persist(tempConversations);
    }

    setInput('');
    setLoading(true);

    // Simular resposta da IA
    setTimeout(() => {
      const responses = [
        'Entendi sua mensagem. Processando informações...',
        'Analisando dados do sistema. Aguarde...',
        'Conexão estabelecida. Transmitindo dados...',
        'Sistema respondendo: suas instruções foram recebidas.'
      ];
      
      const assistantText = responses[Math.floor(Math.random() * responses.length)];
      const assistantMsg = { role: 'assistant', content: assistantText, ts: Date.now() };
      const convId = resp.data.conversation_id;
      const convTitle = resp.data.title;

      if (!selectedId) {
        const newConv = { id: convId, title: convTitle, messages: [userMsg, assistantMsg] };
        const next = [newConv, ...conversations];
        persist(next);
        setSelectedId(convId);
      } else {
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
      }
    } catch (err) {
      console.error('Error in chat', err);
      const errMsg = { role: 'assistant', content: 'Erro: não foi possível obter resposta.', ts: Date.now() };
      if (selectedId) {
        const withError = tempConversations.map((c) =>
          c.id === selectedId ? { ...c, messages: [...c.messages, errMsg] } : c
        );
        persist(withError);
      }
    } finally {
      setLoading(false);
    }, 1000);
  };

  const selectedConv = conversations.find((c) => c.id === selectedId) || null;

  if (!isLoggedIn) {
    return (
      <div style={{
        display: 'flex',
        height: '100vh',
        justifyContent: 'center',
        alignItems: 'center',
        background: theme.background,
        flexDirection: 'column',
        gap: 60,
        fontFamily: 'Courier New, monospace',
        overflow: 'hidden'
      }}>
        <style>{`
          @keyframes flicker {
            0%, 18%, 22%, 25%, 53%, 57%, 100% { text-shadow: 0 0 10px #00ff00, 0 0 20px #00ff00, 0 0 40px #00ff00; }
            20%, 24%, 55% { text-shadow: none; }
          }
          .matrix-title {
            animation: flicker 3s infinite;
          }
        `}</style>
        <h1 className="matrix-title" style={{
          fontSize: 64,
          fontWeight: 900,
          margin: 0,
          color: theme.text,
          textAlign: 'center',
          lineHeight: 1,
          letterSpacing: 3
        }}>
          Hello Brow
        </h1>
        <button 
          onClick={login}
          style={{
            padding: '12px 32px',
            fontSize: 16,
            fontFamily: 'Courier New, monospace',
            border: `2px solid ${theme.accent}`,
            background: theme.background,
            color: theme.accent,
            fontWeight: 'bold',
            cursor: 'pointer',
            textShadow: `0 0 10px ${theme.accent}`,
            boxShadow: `0 0 20px rgba(0, 255, 0, 0.3)`,
            transition: 'all 0.3s'
          }}
          onMouseEnter={(e) => {
            e.target.style.boxShadow = `0 0 30px rgba(0, 255, 0, 0.6)`;
            e.target.style.background = theme.selected;
          }}
          onMouseLeave={(e) => {
            e.target.style.boxShadow = `0 0 20px rgba(0, 255, 0, 0.3)`;
            e.target.style.background = theme.background;
          }}
        >
          [ CONECTAR ]
        </button>
      </div>
    );
  }

  return (
    <div style={{ 
      display: 'flex', 
      height: '100vh', 
      fontFamily: 'Courier New, monospace',
      background: theme.background,
      color: theme.text,
      flexDirection: 'column'
    }}>
      {/* Banner */}
      <div style={{
        background: 'linear-gradient(135deg, #0d2d0d 0%, #050805 100%)',
        padding: '20px 24px',
        borderBottom: `2px solid ${theme.accent}`,
        textAlign: 'center',
        boxShadow: `0 0 20px rgba(0, 255, 0, 0.2)`
      }}>
        <h1 style={{
          margin: 0,
          fontSize: 42,
          fontWeight: 900,
          color: theme.accent,
          letterSpacing: 4,
          textShadow: `0 0 15px ${theme.accent}, 0 0 30px rgba(0, 255, 0, 0.3)`,
          fontFamily: 'Courier New, monospace'
        }}>
          ▓ Hello Brow ▓
        </h1>
      </div>

      <div style={{ display: 'flex', flex: 1 }}>
        {/* Left sidebar: conversations */}
        <div style={{ 
          width: 280, 
          borderRight: `1px solid ${theme.border}`, 
          padding: 12, 
          boxSizing: 'border-box',
          background: theme.sidebar,
          boxShadow: `inset -5px 0 15px rgba(0, 255, 0, 0.05)`
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
              disabled={loading}
              maxLength={20000}
            />
            <div style={{ fontSize: 12, color: tokenEstimate > 4000 ? 'red' : theme.secondaryText }}>
              Est. tokens: {tokenEstimate} {tokenEstimate > 4000 ? '(alto — pode exceder limites)' : ''}
            </div>
          </div>
          <button 
            onClick={sendMessage} 
            disabled={loading || !input} 
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
  );
}

function AppWithTheme() {
  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

export default AppWithTheme;