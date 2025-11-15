import os
import time
import logging
from typing import Optional, List

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

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
if not GOOGLE_CLIENT_ID:
    logger.warning("GOOGLE_CLIENT_ID not set — Google auth disabled")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your-secret-key-change-this")  # Mude para um segredo seguro
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 1440  # 24 horas

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
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    conversations = relationship("Conversation", back_populates="user")

class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(BigInteger, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.id"), index=True)
    title = Column(String(255), default="Conversation")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation")

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
                        "content": "Gere um título curto e descritivo (máximo 6 palavras) para uma conversa baseada no contexto fornecido. Responda APENAS com o título, sem aspas ou pontuação extra."
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
                    if len(title) > 60:
                        title = title[:57] + "..."
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

# ============================================================================
# FASTAPI APP INITIALIZATION
# ============================================================================
app = FastAPI(
    title="MyAgent API",
    description="AI Chat Agent with conversation management",
    version="1.0.0"
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
    logger.info("🚀 Starting MyAgent API...")
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
        return {"status": "healthy", "database": "connected"}
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
        else:
            user.name = name
            user.picture = picture
            db.commit()
            db.refresh(user)

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

@app.post("/auth/dev", response_model=Token)
async def auth_dev(db: Session = Depends(get_db)):
    if os.getenv("DEV_MODE", "false").lower() != "true":
        raise HTTPException(status_code=404, detail="Not found")

    try:
        user_id = "dev-user"
        email = "dev@example.com"
        name = "Developer"
        picture = "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y"

        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            user = User(id=user_id, email=email, name=name, picture=picture)
            db.add(user)
            db.commit()
            db.refresh(user)
            logger.info("Created development user")
        
        access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        access_token = create_access_token(
            data={"sub": user.id}, expires_delta=access_token_expires
        )
        return {"access_token": access_token, "token_type": "bearer"}
    except Exception as e:
        logger.error(f"Dev auth error: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


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
async def get_messages(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        # Filtrar mensagens de conversas do usuário
        messages = db.query(Message).join(Conversation).filter(Conversation.user_id == current_user.id).order_by(Message.id.desc()).all()
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
        title = payload.title or "New Conversation"
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
async def list_conversations(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        convs = db.query(Conversation).filter(Conversation.user_id == current_user.id).order_by(Conversation.created_at.desc()).all()
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
        conv = db.query(Conversation).filter(Conversation.id == conv_id, Conversation.user_id == current_user.id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found or not owned by user")
        
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
        conv = db.query(Conversation).filter(Conversation.id == conv_id, Conversation.user_id == current_user.id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found or not owned by user")
        
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
        conv = db.query(Conversation).filter(Conversation.id == conv_id, Conversation.user_id == current_user.id).first()
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found or not owned by user")
        
        db.delete(conv)
        db.commit()
        logger.info(f"Conversation {conv_id} deleted by user {current_user.id}")
        return {"status": "success", "id": conv_id}
    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting conversation {conv_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# ============================================================================
# CHAT ENDPOINT (OpenAI Integration)
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

    model = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            conv_id = req.conversation_id
            is_new_conversation = False
            
            if conv_id is None:
                title = await generate_conversation_title(f"Usuário: {req.message}", api_key)
                conv = Conversation(title=title, user_id=current_user.id)
                db.add(conv)
                db.commit()
                db.refresh(conv)
                conv_id = conv.id
                is_new_conversation = True
                logger.info(f"Created new conversation: {conv_id} with title: {title} by user {current_user.id}")
            else:
                conv = db.query(Conversation).filter(Conversation.id == conv_id, Conversation.user_id == current_user.id).first()
                if not conv:
                    title = await generate_conversation_title(f"Usuário: {req.message}", api_key)
                    conv = Conversation(id=conv_id, title=title, user_id=current_user.id)
                    db.add(conv)
                    db.commit()
                    db.refresh(conv)
                    is_new_conversation = True
                    logger.info(f"Created conversation with ID: {conv_id} and title: {title} by user {current_user.id}")

            previous_messages = db.query(Message)\
                .filter(Message.conversation_id == conv_id)\
                .order_by(Message.id.asc())\
                .all()

            messages = [
                {"role": "system", "content": "You are a helpful assistant."}
            ]
            
            for msg in previous_messages:
                messages.append({"role": msg.role, "content": msg.content})
            
            messages.append({"role": "user", "content": req.message})

            user_msg = Message(
                conversation_id=conv_id,
                role='user',
                content=req.message
            )
            db.add(user_msg)
            db.commit()
            logger.info(f"User message saved to conversation {conv_id} by user {current_user.id}")

            payload = {
                "model": model,
                "messages": messages,
                "max_tokens": 800,
                "temperature": 0.7,
            }

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }

            logger.info(f"Calling OpenAI API with model {model}")
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json=payload,
                headers=headers
            )
            r.raise_for_status()
            data = r.json()
            
            assistant_text = ""
            if "choices" in data and len(data["choices"]) > 0:
                choice = data["choices"][0]
                if "message" in choice and "content" in choice["message"]:
                    assistant_text = choice["message"]["content"]
                elif "text" in choice:
                    assistant_text = choice["text"]

            if not assistant_text:
                logger.warning("Empty response from OpenAI")
                assistant_text = "I apologize, but I couldn't generate a response."

            assistant_msg = Message(
                conversation_id=conv_id,
                role='assistant',
                content=assistant_text
            )
            db.add(assistant_msg)
            db.commit()
            logger.info(f"Assistant response saved to conversation {conv_id}")

            await update_conversation_title(conv_id, db, api_key)

            conv = db.query(Conversation).filter(Conversation.id == conv_id).first()
            
            response_data = ChatResponse(
                reply=assistant_text, 
                conversation_id=conv_id,
                title=conv.title if conv else None
            )

            return response_data
            
        except httpx.HTTPStatusError as e:
            db.rollback()
            logger.error(f"OpenAI API error: {str(e)}")
            raise HTTPException(
                status_code=502,
                detail=f"Upstream API error: {str(e)}"
            )
        except Exception as e:
            db.rollback()
            logger.error(f"Chat error: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)