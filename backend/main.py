# main.py - MyAgent Backend Completo com Integração Spotify
import os
import time
import logging
import json
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, DateTime, BigInteger, func
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session, relationship
from sqlalchemy.exc import OperationalError
import httpx
from dotenv import load_dotenv
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import JWTError, jwt
from fastapi.security import OAuth2PasswordBearer
from datetime import datetime, timedelta
import spotipy
from spotipy.oauth2 import SpotifyOAuth

# ============================================================================
# LOGGING CONFIGURATION
# ============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# ENVIRONMENT CONFIGURATION
# ============================================================================
load_dotenv()

# Google OAuth
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
if not GOOGLE_CLIENT_ID:
    logger.warning("GOOGLE_CLIENT_ID not set — Google auth disabled")

# OpenAI
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# JWT
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your-secret-key-change-this")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 1440  # 24 horas

# Spotify Configuration
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI", "http://localhost:3000/spotify/callback")
SPOTIFY_SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-modify-public playlist-modify-private user-top-read user-library-read"

if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
    logger.warning("SPOTIFY credentials not set — Spotify features disabled")

# ============================================================================
# DATABASE CONFIGURATION
# ============================================================================
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@db:5432/postgres")
engine = create_engine(DATABASE_URL, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ============================================================================
# DATABASE MODELS
# ============================================================================
class User(Base):
    __tablename__ = "users"
    id = Column(String, primary_key=True, index=True)  # Google sub
    email = Column(String(255), unique=True, index=True)
    name = Column(String(255))
    picture = Column(String(255))
    spotify_token = Column(Text, nullable=True)
    spotify_refresh_token = Column(Text, nullable=True)
    spotify_token_expires_at = Column(BigInteger, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")

class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(BigInteger, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), index=True)
    title = Column(String(255), default="Conversation")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")

class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(BigInteger, ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role = Column(String(32), nullable=False)
    content = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    conversation = relationship("Conversation", back_populates="messages")

# ============================================================================
# DATABASE INITIALIZATION WITH RETRY LOGIC
# ============================================================================
def init_db(max_retries: int = 5, retry_interval: int = 5):
    logger.info("Starting database initialization...")
    
    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"Database connection attempt {attempt}/{max_retries}")
            
            with engine.connect() as conn:
                conn.execute(func.now())
            
            if os.getenv("DB_RESET_ON_STARTUP", "false").lower() == "true":
                logger.warning("Dropping all existing tables...")
                Base.metadata.drop_all(bind=engine)
            
            logger.info("Creating all tables...")
            Base.metadata.create_all(bind=engine)
            
            logger.info("✅ Database initialized successfully!")
            return
            
        except OperationalError as e:
            if attempt < max_retries:
                logger.warning(
                    f"⚠️  Database not ready: {str(e)}\n"
                    f"   Retrying in {retry_interval}s... ({attempt}/{max_retries})"
                )
                time.sleep(retry_interval)
            else:
                logger.error(f"❌ Failed to connect to database after {max_retries} attempts")
                raise HTTPException(
                    status_code=503,
                    detail="Database connection failed after maximum retries"
                )
        except Exception as e:
            logger.error(f"❌ Unexpected error during database initialization: {str(e)}")
            raise

# ============================================================================
# DATABASE DEPENDENCY
# ============================================================================
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ============================================================================
# AUTH HELPERS
# ============================================================================
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/google")

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception
    return user

# ============================================================================
# SPOTIFY HELPERS
# ============================================================================
def refresh_spotify_token(user: User, db: Session) -> bool:
    """Renova token Spotify se expirado"""
    try:
        if not user.spotify_refresh_token:
            return False
        
        current_time = int(time.time())
        if user.spotify_token_expires_at and current_time < user.spotify_token_expires_at:
            return True  # Token ainda válido
        
        sp_oauth = SpotifyOAuth(
            client_id=SPOTIFY_CLIENT_ID,
            client_secret=SPOTIFY_CLIENT_SECRET,
            redirect_uri=SPOTIFY_REDIRECT_URI,
            scope=SPOTIFY_SCOPE
        )
        
        token_info = sp_oauth.refresh_access_token(user.spotify_refresh_token)
        user.spotify_token = token_info['access_token']
        user.spotify_token_expires_at = int(time.time()) + token_info['expires_in']
        
        if 'refresh_token' in token_info:
            user.spotify_refresh_token = token_info['refresh_token']
        
        db.commit()
        logger.info(f"Refreshed Spotify token for user {user.id}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to refresh Spotify token: {str(e)}")
        return False

def get_spotify_client(user: User, db: Session) -> Optional[spotipy.Spotify]:
    """Retorna cliente Spotify autenticado para o usuário"""
    if not user.spotify_token:
        return None
    
    # Tentar renovar token se necessário
    refresh_spotify_token(user, db)
    
    try:
        sp = spotipy.Spotify(auth=user.spotify_token)
        # Testar conexão
        sp.current_user()
        return sp
    except Exception as e:
        logger.error(f"Erro ao criar cliente Spotify: {str(e)}")
        return None

# ============================================================================
# AI AGENT SYSTEM PROMPT
# ============================================================================
MYAGENT_SYSTEM_PROMPT = """Você é MyAgent, um agente de IA especializado em controlar o Spotify através de comandos naturais.

# COMPORTAMENTO PRINCIPAL
- Você interpreta comandos do usuário e os transforma em ações no Spotify
- Sempre responda de forma natural e amigável
- Confirme as ações realizadas
- Se algo não for possível, explique o motivo claramente

# DETECÇÃO DE INTENÇÕES
Quando o usuário pedir algo relacionado a música/Spotify, você deve identificar a intenção:

**Intenções disponíveis:**
1. "search" - buscar músicas, artistas, álbuns
2. "play" - tocar música específica
3. "pause" - pausar reprodução
4. "next" - próxima faixa
5. "previous" - faixa anterior  
6. "create_playlist" - criar nova playlist
7. "add_to_playlist" - adicionar música a playlist
8. "devices" - listar dispositivos disponíveis
9. "transfer_playback" - mudar reprodução para outro dispositivo
10. "recommend" - obter recomendações

# FORMATO DE RESPOSTA PARA COMANDOS SPOTIFY
Quando identificar um comando Spotify, responda APENAS com JSON puro (sem markdown):

{
  "intent": "nome_da_intent",
  "payload": { dados necessários },
  "response": "mensagem amigável para o usuário"
}

# EXEMPLOS

Usuário: "toca linkin park"
Resposta:
{
  "intent": "search",
  "payload": {"query": "linkin park"},
  "response": "Buscando Linkin Park no Spotify..."
}

Usuário: "pausa a música"
Resposta:
{
  "intent": "pause",
  "payload": {},
  "response": "Pausando a reprodução..."
}

Usuário: "próxima"
Resposta:
{
  "intent": "next",
  "payload": {},
  "response": "Pulando para a próxima faixa..."
}

Usuário: "cria uma playlist chamada treino"
Resposta:
{
  "intent": "create_playlist",
  "payload": {"name": "treino", "description": "Playlist criada por MyAgent"},
  "response": "Criando playlist 'treino'..."
}

# CONVERSAÇÃO NORMAL
Se o usuário não estiver pedindo ação do Spotify, responda normalmente como assistente conversacional.
Exemplos: cumprimentos, perguntas gerais, dúvidas sobre funcionalidades, etc.

# WAKE WORD "amigo"
Quando o usuário disser "amigo" no início da frase, identifique isso como ativação do modo de escuta.
Processe o restante da mensagem normalmente.

Exemplo: "amigo, toca racionais" → processar como "toca racionais"
"""

# ============================================================================
# AGENT AI HELPER (Detecta intenções e processa comandos)
# ============================================================================
async def process_with_agent(message: str, api_key: str, conversation_history: List[Dict] = None) -> Dict[str, Any]:
    """
    Processa mensagem através do agente AI
    Retorna: {"is_spotify_command": bool, "intent": dict ou None, "reply": str}
    """
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            messages = [{"role": "system", "content": MYAGENT_SYSTEM_PROMPT}]
            
            # Adicionar histórico de conversa se disponível
            if conversation_history:
                messages.extend(conversation_history[-6:])  # Últimas 6 mensagens
            
            messages.append({"role": "user", "content": message})
            
            payload = {
                "model": "gpt-3.5-turbo",
                "messages": messages,
                "max_tokens": 500,
                "temperature": 0.7,
            }
            
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json=payload,
                headers=headers
            )
            
            if r.status_code == 200:
                data = r.json()
                if "choices" in data and len(data["choices"]) > 0:
                    response_text = data["choices"][0]["message"]["content"].strip()
                    
                    # Tentar parsear como JSON (comando Spotify)
                    try:
                        # Limpar markdown se existir
                        cleaned = response_text.replace("```json", "").replace("```", "").strip()
                        intent_data = json.loads(cleaned)
                        
                        if "intent" in intent_data and intent_data["intent"]:
                            return {
                                "is_spotify_command": True,
                                "intent": intent_data,
                                "reply": intent_data.get("response", "Processando comando...")
                            }
                    except json.JSONDecodeError:
                        # Não é JSON, é resposta normal
                        pass
                    
                    # Resposta conversacional normal
                    return {
                        "is_spotify_command": False,
                        "intent": None,
                        "reply": response_text
                    }
            
            return {
                "is_spotify_command": False,
                "intent": None,
                "reply": "Desculpe, não consegui processar sua mensagem."
            }
            
    except Exception as e:
        logger.error(f"Error processing with agent: {str(e)}")
        return {
            "is_spotify_command": False,
            "intent": None,
            "reply": "Ocorreu um erro ao processar sua mensagem."
        }

# ============================================================================
# SPOTIFY ACTION EXECUTOR
# ============================================================================
async def execute_spotify_action(intent: Dict[str, Any], user: User, db: Session) -> Dict[str, Any]:
    """Executa ação no Spotify baseado na intent"""
    sp = get_spotify_client(user, db)
    if not sp:
        return {
            "success": False,
            "message": "Você precisa conectar sua conta Spotify primeiro. Use /spotify/auth-url para começar."
        }
    
    try:
        intent_type = intent.get("intent")
        payload = intent.get("payload", {})
        
        if intent_type == "search":
            query = payload.get("query")
            results = sp.search(q=query, limit=5, type='track')
            tracks = results.get("tracks", {}).get("items", [])
            
            if tracks:
                track_list = "\n".join([
                    f"{i+1}. {t['name']} - {t['artists'][0]['name']}"
                    for i, t in enumerate(tracks)
                ])
                return {
                    "success": True,
                    "message": f"Encontrei estas músicas:\n{track_list}\n\nDiga 'toca a primeira' para reproduzir.",
                    "data": {"tracks": tracks}
                }
            else:
                return {"success": False, "message": "Nenhuma música encontrada."}
        
        elif intent_type == "play":
            query = payload.get("query")
            track_uri = payload.get("track_uri")
            
            if track_uri:
                sp.start_playback(uris=[track_uri])
                return {"success": True, "message": "Reproduzindo música!"}
            elif query:
                results = sp.search(q=query, limit=1, type='track')
                tracks = results.get("tracks", {}).get("items", [])
                if tracks:
                    track = tracks[0]
                    sp.start_playback(uris=[track['uri']])
                    return {
                        "success": True,
                        "message": f"Reproduzindo: {track['name']} - {track['artists'][0]['name']}"
                    }
                else:
                    return {"success": False, "message": "Música não encontrada."}
            else:
                # Apenas play sem parâmetros = resume
                sp.start_playback()
                return {"success": True, "message": "Retomando reprodução!"}
        
        elif intent_type == "pause":
            sp.pause_playback()
            return {"success": True, "message": "Música pausada."}
        
        elif intent_type == "next":
            sp.next_track()
            return {"success": True, "message": "Pulando para a próxima música..."}
        
        elif intent_type == "previous":
            sp.previous_track()
            return {"success": True, "message": "Voltando para a música anterior..."}
        
        elif intent_type == "create_playlist":
            name = payload.get("name", "Nova Playlist")
            description = payload.get("description", "Criada por MyAgent")
            user_id = sp.current_user()["id"]
            playlist = sp.user_playlist_create(user_id, name, description=description)
            return {
                "success": True,
                "message": f"Playlist '{name}' criada com sucesso!",
                "data": {"playlist_id": playlist["id"]}
            }
        
        elif intent_type == "add_to_playlist":
            playlist_id = payload.get("playlist_id")
            track_uri = payload.get("track_uri")
            
            if playlist_id and track_uri:
                sp.playlist_add_items(playlist_id, [track_uri])
                return {"success": True, "message": "Música adicionada à playlist!"}
            else:
                return {"success": False, "message": "Faltam informações para adicionar à playlist."}
        
        elif intent_type == "devices":
            devices = sp.devices()
            device_list = devices.get("devices", [])
            if device_list:
                devices_text = "\n".join([
                    f"- {d['name']} ({'ativo' if d['is_active'] else 'inativo'})"
                    for d in device_list
                ])
                return {
                    "success": True,
                    "message": f"Dispositivos disponíveis:\n{devices_text}",
                    "data": {"devices": device_list}
                }
            else:
                return {"success": False, "message": "Nenhum dispositivo Spotify encontrado."}
        
        elif intent_type == "transfer_playback":
            device_id = payload.get("device_id")
            if device_id:
                sp.transfer_playback(device_id)
                return {"success": True, "message": "Reprodução transferida!"}
            else:
                return {"success": False, "message": "ID do dispositivo não fornecido."}
        
        elif intent_type == "recommend":
            # Obter recomendações baseadas nas top tracks do usuário
            top_tracks = sp.current_user_top_tracks(limit=5, time_range='short_term')
            seed_tracks = [t['id'] for t in top_tracks['items'][:2]]
            
            if seed_tracks:
                recommendations = sp.recommendations(seed_tracks=seed_tracks, limit=5)
                rec_list = "\n".join([
                    f"{i+1}. {t['name']} - {t['artists'][0]['name']}"
                    for i, t in enumerate(recommendations['tracks'])
                ])
                return {
                    "success": True,
                    "message": f"Recomendações para você:\n{rec_list}",
                    "data": {"tracks": recommendations['tracks']}
                }
            else:
                return {"success": False, "message": "Não consegui gerar recomendações."}
        
        else:
            return {"success": False, "message": f"Ação '{intent_type}' não reconhecida."}
    
    except spotipy.exceptions.SpotifyException as e:
        logger.error(f"Spotify API error: {str(e)}")
        if e.http_status == 404:
            return {"success": False, "message": "Nenhum dispositivo Spotify ativo encontrado. Abra o Spotify em algum dispositivo."}
        return {"success": False, "message": f"Erro no Spotify: {str(e)}"}
    except Exception as e:
        logger.error(f"Error executing Spotify action: {str(e)}")
        return {"success": False, "message": f"Erro ao executar ação: {str(e)}"}

# ============================================================================
# HELPER: Generate conversation title from context
# ============================================================================
async def generate_conversation_title(messages_context: str, api_key: str) -> str:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            payload = {
                "model": "gpt-3.5-turbo",
                "messages": [
                    {
                        "role": "system",
                        "content": "Gere um título curto (máximo 50 caracteres) que resuma o tema desta conversa. Responda apenas com o título, sem aspas ou formatação extra."
                    },
                    {
                        "role": "user",
                        "content": f"Contexto da conversa: {messages_context[:400]}"
                    }
                ],
                "max_tokens": 20,
                "temperature": 0.7,
            }
            
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json=payload,
                headers=headers
            )
            
            if r.status_code == 200:
                data = r.json()
                if "choices" in data and len(data["choices"]) > 0:
                    title = data["choices"][0]["message"]["content"].strip()
                    title = title.strip('"\'')
                    if len(title) > 50:
                        title = title[:47] + "..."
                    return title
    except Exception as e:
        logger.warning(f"Failed to generate title: {str(e)}")
    
    words = messages_context.split()[:6]
    return " ".join(words) + ("..." if len(messages_context.split()) > 6 else "")

async def update_conversation_title(conv_id: int, db: Session, api_key: str):
    try:
        msg_count = db.query(Message).filter(Message.conversation_id == conv_id).count()
        if msg_count < 3:
            return
        
        recent_messages = db.query(Message)\
            .filter(Message.conversation_id == conv_id)\
            .order_by(Message.id.asc())\
            .limit(6)\
            .all()
        
        context_parts = []
        for msg in recent_messages:
            prefix = "Usuário" if msg.role == "user" else "Assistente"
            context_parts.append(f"{prefix}: {msg.content[:150]}")
        
        context = " | ".join(context_parts)
        
        new_title = await generate_conversation_title(context, api_key)
        
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        if conv and conv.title != new_title:
            conv.title = new_title
            db.commit()
            logger.info(f"Updated conversation {conv_id} title to: {new_title}")
            
    except Exception as e:
        logger.warning(f"Failed to update conversation title: {str(e)}")

# ============================================================================
# PYDANTIC SCHEMAS
# ============================================================================
class GoogleToken(BaseModel):
    id_token: str

class Token(BaseModel):
    access_token: str
    token_type: str

class MessageSchema(BaseModel):
    message: str

class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[int] = None

class ConversationCreate(BaseModel):
    title: Optional[str] = None

class ConversationUpdate(BaseModel):
    title: str

class MessageResponse(BaseModel):
    id: int
    role: str
    content: str
    conversation_id: Optional[int]

class ConversationResponse(BaseModel):
    id: int
    title: str
    message_count: int
    preview: str

class ConversationDetailResponse(BaseModel):
    id: int
    title: str
    messages: List[dict]

class ChatResponse(BaseModel):
    reply: str
    conversation_id: int
    title: Optional[str] = None
    spotify_action: Optional[Dict[str, Any]] = None

class SpotifySearchRequest(BaseModel):
    query: str

class SpotifyPlayRequest(BaseModel):
    track_uri: Optional[str] = None
    query: Optional[str] = None

class SpotifyPlaylistCreate(BaseModel):
    name: str
    description: Optional[str] = None

class SpotifyAddToPlaylist(BaseModel):
    playlist_id: str
    track_uri: str

class SpotifyTransferPlayback(BaseModel):
    device_id: str

# ============================================================================
# FASTAPI APP INITIALIZATION
# ============================================================================
app = FastAPI(
    title="MyAgent API",
    description="AI Chat Agent with Spotify integration and conversation management",
    version="2.0.0"
)

# ============================================================================
# CORS CONFIGURATION
# ============================================================================
_allowed = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
if _allowed.strip() == "*":
    allow_origins = ["*"]
else:
    allow_origins = [o.strip() for o in _allowed.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================================
# STARTUP EVENT
# ============================================================================
@app.on_event("startup")
async def startup_event():
    logger.info("🚀 Starting MyAgent API with Spotify integration...")
    init_db()
    logger.info("✅ Application ready!")

# ============================================================================
# HEALTH CHECK ENDPOINT
# ============================================================================
@app.get("/health")
async def health():
    try:
        with engine.connect() as conn:
            conn.execute(func.now())
        return {
            "status": "healthy",
            "database": "connected",
            "spotify": "configured" if SPOTIFY_CLIENT_ID else "not configured"
        }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        raise HTTPException(status_code=503, detail="Service unhealthy")

# ============================================================================
# AUTH ENDPOINT
# ============================================================================
@app.post("/auth/google", response_model=Token)
async def auth_google(google_token: GoogleToken, db: Session = Depends(get_db)):
    try:
        # Verificar ID token do Google
        user_info = id_token.verify_oauth2_token(
            google_token.id_token,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )
        if user_info['iss'] not in ['accounts.google.com', 'https://accounts.google.com']:
            raise ValueError('Wrong issuer.')
        
        user_id = user_info['sub']
        email = user_info['email']
        name = user_info.get('name')
        picture = user_info.get('picture')

        # Criar ou atualizar usuário
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            user = User(id=user_id, email=email, name=name, picture=picture)
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info(f"New user created: {email}")
        else:
            user.name = name
            user.picture = picture
            db.commit()
            db.refresh(user)
            logger.info(f"User logged in: {email}")

        # Gerar JWT
        access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        access_token = create_access_token(
            data={"sub": user.id}, expires_delta=access_token_expires
        )
        return {"access_token": access_token, "token_type": "bearer"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Auth error: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")

# ============================================================================
# SPOTIFY AUTH ENDPOINTS
# ============================================================================
@app.get("/spotify/auth-url")
async def get_spotify_auth_url(current_user: User = Depends(get_current_user)):
    """Retorna URL de autenticação Spotify"""
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="Spotify credentials not configured on server"
        )
    
    try:
        sp_oauth = SpotifyOAuth(
            client_id=SPOTIFY_CLIENT_ID,
            client_secret=SPOTIFY_CLIENT_SECRET,
            redirect_uri=SPOTIFY_REDIRECT_URI,
            scope=SPOTIFY_SCOPE,
            state=current_user.id  # Pass user ID in state for security
        )
        auth_url = sp_oauth.get_authorize_url()
        logger.info(f"Generated Spotify auth URL for user {current_user.id}")
        return {"auth_url": auth_url}
    except Exception as e:
        logger.error(f"Error generating Spotify auth URL: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/spotify/callback")
async def spotify_callback(
    code: str,
    state: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Callback OAuth Spotify - recebe código de autorização"""
    try:
        sp_oauth = SpotifyOAuth(
            client_id=SPOTIFY_CLIENT_ID,
            client_secret=SPOTIFY_CLIENT_SECRET,
            redirect_uri=SPOTIFY_REDIRECT_URI,
            scope=SPOTIFY_SCOPE
        )
        
        token_info = sp_oauth.get_access_token(code)
        
        if not token_info:
            raise HTTPException(status_code=400, detail="Failed to get access token")
        
        # Se state foi passado, atualizar o usuário específico
        if state:
            user = db.query(User).filter(User.id == state).first()
            if user:
                user.spotify_token = token_info['access_token']
                user.spotify_refresh_token = token_info.get('refresh_token')
                user.spotify_token_expires_at = int(time.time()) + token_info.get('expires_in', 3600)
                db.commit()
                logger.info(f"Spotify connected for user {user.id}")
        
        return {
            "status": "success",
            "message": "Spotify connected successfully!",
            "redirect": "http://localhost:3000"  # Redirecionar para frontend
        }
    except Exception as e:
        logger.error(f"Spotify callback error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/spotify/status")
async def spotify_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Verifica status da conexão Spotify"""
    if not current_user.spotify_token:
        return {"connected": False, "message": "Spotify not connected"}
    
    sp = get_spotify_client(current_user, db)
    if not sp:
        return {"connected": False, "message": "Token expired or invalid"}
    
    try:
        user_info = sp.current_user()
        return {
            "connected": True,
            "spotify_user": user_info.get("display_name"),
            "spotify_id": user_info.get("id")
        }
    except Exception as e:
        logger.error(f"Error checking Spotify status: {str(e)}")
        return {"connected": False, "message": "Failed to verify connection"}

@app.post("/spotify/disconnect")
async def spotify_disconnect(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Desconecta conta Spotify"""
    try:
        current_user.spotify_token = None
        current_user.spotify_refresh_token = None
        current_user.spotify_token_expires_at = None
        db.commit()
        logger.info(f"Spotify disconnected for user {current_user.id}")
        return {"status": "success", "message": "Spotify disconnected"}
    except Exception as e:
        logger.error(f"Error disconnecting Spotify: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# SPOTIFY ACTION ENDPOINTS (Direct API calls)
# ============================================================================
@app.post("/spotify/search")
async def spotify_search(
    req: SpotifySearchRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Buscar músicas, artistas, álbuns"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        results = sp.search(q=req.query, limit=10, type='track,artist,album')
        return {"results": results}
    except Exception as e:
        logger.error(f"Spotify search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/play")
async def spotify_play(
    req: SpotifyPlayRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Tocar música"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        if req.track_uri:
            sp.start_playback(uris=[req.track_uri])
            return {"status": "playing", "track_uri": req.track_uri}
        elif req.query:
            results = sp.search(q=req.query, limit=1, type='track')
            if results['tracks']['items']:
                track = results['tracks']['items'][0]
                sp.start_playback(uris=[track['uri']])
                return {
                    "status": "playing",
                    "track": {
                        "name": track['name'],
                        "artist": track['artists'][0]['name'],
                        "uri": track['uri']
                    }
                }
            else:
                raise HTTPException(status_code=404, detail="Track not found")
        else:
            # Resume playback
            sp.start_playback()
            return {"status": "resumed"}
    except spotipy.exceptions.SpotifyException as e:
        if e.http_status == 404:
            raise HTTPException(status_code=404, detail="No active device found. Open Spotify on a device.")
        logger.error(f"Spotify play error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"Spotify play error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/pause")
async def spotify_pause(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Pausar música"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        sp.pause_playback()
        return {"status": "paused"}
    except Exception as e:
        logger.error(f"Spotify pause error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/next")
async def spotify_next(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Próxima música"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        sp.next_track()
        return {"status": "next"}
    except Exception as e:
        logger.error(f"Spotify next error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/previous")
async def spotify_previous(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Música anterior"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        sp.previous_track()
        return {"status": "previous"}
    except Exception as e:
        logger.error(f"Spotify previous error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/create-playlist")
async def create_playlist(
    req: SpotifyPlaylistCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Criar playlist"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        user_id = sp.current_user()['id']
        playlist = sp.user_playlist_create(
            user_id,
            req.name,
            public=True,
            description=req.description or "Criada por MyAgent"
        )
        return {
            "status": "created",
            "playlist": {
                "id": playlist['id'],
                "name": playlist['name'],
                "url": playlist['external_urls']['spotify']
            }
        }
    except Exception as e:
        logger.error(f"Spotify create playlist error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/add-to-playlist")
async def add_to_playlist(
    req: SpotifyAddToPlaylist,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Adicionar música a playlist"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        sp.playlist_add_items(req.playlist_id, [req.track_uri])
        return {"status": "added"}
    except Exception as e:
        logger.error(f"Spotify add to playlist error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/spotify/devices")
async def get_devices(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Listar dispositivos Spotify"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        devices = sp.devices()
        return {"devices": devices.get('devices', [])}
    except Exception as e:
        logger.error(f"Spotify devices error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/spotify/transfer-playback")
async def transfer_playback(
    req: SpotifyTransferPlayback,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Transferir reprodução para outro dispositivo"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        sp.transfer_playback(req.device_id, force_play=True)
        return {"status": "transferred"}
    except Exception as e:
        logger.error(f"Spotify transfer playback error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/spotify/current-playback")
async def current_playback(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Obter informações da música atual"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        playback = sp.current_playback()
        if not playback:
            return {"playing": False}
        
        track = playback.get('item', {})
        return {
            "playing": playback.get('is_playing', False),
            "track": {
                "name": track.get('name'),
                "artist": track.get('artists', [{}])[0].get('name'),
                "album": track.get('album', {}).get('name'),
                "uri": track.get('uri'),
                "progress_ms": playback.get('progress_ms'),
                "duration_ms": track.get('duration_ms')
            },
            "device": {
                "name": playback.get('device', {}).get('name'),
                "type": playback.get('device', {}).get('type')
            }
        }
    except Exception as e:
        logger.error(f"Spotify current playback error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/spotify/recommend")
async def get_recommendations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Obter recomendações musicais"""
    sp = get_spotify_client(current_user, db)
    if not sp:
        raise HTTPException(status_code=401, detail="Spotify not connected")
    
    try:
        # Obter top tracks do usuário como seed
        top_tracks = sp.current_user_top_tracks(limit=5, time_range='short_term')
        seed_tracks = [t['id'] for t in top_tracks.get('items', [])[:2]]
        
        if not seed_tracks:
            # Fallback: usar músicas salvas
            saved_tracks = sp.current_user_saved_tracks(limit=5)
            seed_tracks = [t['track']['id'] for t in saved_tracks.get('items', [])[:2]]
        
        if seed_tracks:
            recommendations = sp.recommendations(seed_tracks=seed_tracks, limit=10)
            return {
                "tracks": [
                    {
                        "name": t['name'],
                        "artist": t['artists'][0]['name'],
                        "uri": t['uri'],
                        "album": t['album']['name']
                    }
                    for t in recommendations.get('tracks', [])
                ]
            }
        else:
            return {"tracks": [], "message": "Não há histórico suficiente para recomendações"}
    except Exception as e:
        logger.error(f"Spotify recommend error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# MESSAGE ENDPOINTS
# ============================================================================
@app.post("/message")
async def create_message(
    message: MessageSchema,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        db_message = Message(role='user', content=message.message, conversation_id=None)
        db.add(db_message)
        db.commit()
        logger.info(f"Message created: {message.message[:50]}... by user {current_user.id}")
        return {"status": "success"}
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating message: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/messages", response_model=List[MessageResponse])
async def get_messages(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        messages = db.query(Message)\
            .join(Conversation)\
            .filter(Conversation.user_id == current_user.id)\
            .order_by(Message.id.desc())\
            .all()
        return [
            MessageResponse(
                id=msg.id,
                role=msg.role,
                content=msg.content,
                conversation_id=msg.conversation_id
            )
            for msg in messages
        ]
    except Exception as e:
        logger.error(f"Error fetching messages: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# CONVERSATION ENDPOINTS
# ============================================================================
@app.post("/conversations")
async def create_conversation(
    payload: ConversationCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        title = payload.title or "Nova Conversa"
        conv = Conversation(title=title, user_id=current_user.id)
        db.add(conv)
        db.commit()
        db.refresh(conv)
        logger.info(f"Conversation created: {conv.id} - {title} by user {current_user.id}")
        return {"id": conv.id, "title": conv.title}
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating conversation: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/conversations", response_model=List[ConversationResponse])
async def list_conversations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        convs = db.query(Conversation)\
            .filter(Conversation.user_id == current_user.id)\
            .order_by(Conversation.created_at.desc())\
            .all()
        
        result = []
        for c in convs:
            count = db.query(Message).filter(Message.conversation_id == c.id).count()
            last = db.query(Message)\
                .filter(Message.conversation_id == c.id)\
                .order_by(Message.id.desc())\
                .first()
            
            preview = last.content[:200] if last and last.content else ""
            
            result.append(
                ConversationResponse(
                    id=c.id,
                    title=c.title,
                    message_count=count,
                    preview=preview
                )
            )
        
        return result
    except Exception as e:
        logger.error(f"Error listing conversations: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/conversations/{conv_id}", response_model=ConversationDetailResponse)
async def get_conversation(
    conv_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        conv = db.query(Conversation)\
            .filter(Conversation.id == conv_id, Conversation.user_id == current_user.id)\
            .first()
        
        if not conv:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found or not owned by user"
            )
        
        msgs = db.query(Message)\
            .filter(Message.conversation_id == conv_id)\
            .order_by(Message.id.asc())\
            .all()
        
        return ConversationDetailResponse(
            id=conv.id,
            title=conv.title,
            messages=[
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at.isoformat()
                }
                for m in msgs
            ]
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching conversation {conv_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.patch("/conversations/{conv_id}")
async def update_conversation(
    conv_id: int,
    payload: ConversationUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        conv = db.query(Conversation)\
            .filter(Conversation.id == conv_id, Conversation.user_id == current_user.id)\
            .first()
        
        if not conv:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found or not owned by user"
            )
        
        conv.title = payload.title
        db.commit()
        db.refresh(conv)
        logger.info(f"Conversation {conv_id} updated to title: {conv.title} by user {current_user.id}")
        return {"id": conv.id, "title": conv.title}
    except Exception as e:
        db.rollback()
        logger.error(f"Error updating conversation {conv_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/conversations/{conv_id}")
async def delete_conversation(
    conv_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    try:
        conv = db.query(Conversation)\
            .filter(Conversation.id == conv_id, Conversation.user_id == current_user.id)\
            .first()
        
        if not conv:
            raise HTTPException(
                status_code=404,
                detail="Conversation not found or not owned by user"
            )
        
        db.delete(conv)
        db.commit()
        logger.info(f"Conversation {conv_id} deleted by user {current_user.id}")
        return {"status": "success", "id": conv_id}
    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting conversation {conv_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# CHAT ENDPOINT (OpenAI Integration with MyAgent AI)
# ============================================================================
@app.post("/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    api_key = OPENAI_API_KEY
    if not api_key:
        logger.error("OPENAI_API_KEY not configured")
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY not set in environment"
        )

    try:
        conv_id = req.conversation_id
        is_new_conversation = False
        
        # Criar ou recuperar conversa
        if conv_id is None:
            title = await generate_conversation_title(f"Usuário: {req.message}", api_key)
            conv = Conversation(title=title, user_id=current_user.id)
            db.add(conv)
            db.commit()
            db.refresh(conv)
            conv_id = conv.id
            is_new_conversation = True
            logger.info(f"Created new conversation: {conv_id} with title: {title}")
        else:
            conv = db.query(Conversation)\
                .filter(Conversation.id == conv_id, Conversation.user_id == current_user.id)\
                .first()
            if not conv:
                title = await generate_conversation_title(f"Usuário: {req.message}", api_key)
                conv = Conversation(id=conv_id, title=title, user_id=current_user.id)
                db.add(conv)
                db.commit()
                db.refresh(conv)
                is_new_conversation = True

        # Buscar histórico de mensagens
        previous_messages = db.query(Message)\
            .filter(Message.conversation_id == conv_id)\
            .order_by(Message.id.asc())\
            .all()

        # Processar wake-word "amigo"
        wake_word = "amigo"
        is_listening = wake_word in req.message.lower()
        cleaned_message = req.message.lower().replace(wake_word, "", 1).strip() if is_listening else req.message

        # Salvar mensagem do usuário
        user_msg = Message(
            conversation_id=conv_id,
            role='user',
            content=req.message
        )
        db.add(user_msg)
        db.commit()
        logger.info(f"User message saved to conversation {conv_id}")

        # Preparar histórico para o agente
        conversation_history = [
            {"role": msg.role, "content": msg.content}
            for msg in previous_messages
        ]

        # Processar com o agente AI
        agent_response = await process_with_agent(cleaned_message, api_key, conversation_history)

        # Se for comando Spotify, executar ação
        spotify_action_result = None
        if agent_response["is_spotify_command"] and agent_response["intent"]:
            spotify_action_result = await execute_spotify_action(
                agent_response["intent"],
                current_user,
                db
            )
            
            # Atualizar resposta com resultado da ação
            if spotify_action_result["success"]:
                agent_response["reply"] = spotify_action_result["message"]
            else:
                agent_response["reply"] = f"❌ {spotify_action_result['message']}"

        assistant_text = agent_response["reply"]

        # Salvar resposta do assistente
        assistant_msg = Message(
            conversation_id=conv_id,
            role='assistant',
            content=assistant_text
        )
        db.add(assistant_msg)
        db.commit()
        logger.info(f"Assistant response saved to conversation {conv_id}")

        # Atualizar título da conversa se necessário
        await update_conversation_title(conv_id, db, api_key)

        # Buscar conversa atualizada
        conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
        
        response_data = ChatResponse(
            reply=assistant_text,
            conversation_id=conv_id,
            title=conv.title if conv else None,
            spotify_action=spotify_action_result
        )

        return response_data
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# MAIN
# ============================================================================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)