# Project Building RAG

A repository-aware RAG system for understanding and querying GitHub codebases. It combines semantic code retrieval, persistent project context, conversational memory, GitHub OAuth, and caching to provide context-aware answers about a software project.

## Problem

LLMs lose context across conversations and cannot reliably reason over an entire codebase from a single prompt. This system indexes repository code, retrieves relevant implementation details, and preserves compact project and conversation context for future queries.

## Architecture

```text
GitHub OAuth
    |
    v
Repository Selection -> GitHub API -> Repository Tree + Source Files
                                      |
                                      v
                            Language-aware Chunking
                                      |
                                      v
                         Google Gemini Embeddings
                                      |
                                      v
                           Pinecone Vector Store
                                      |
                                      v
Query -> Embedding -> Repository-scoped Retrieval
                                      |
                                      v
       Project Summary + Chat Summary + Relevant Code
                                      |
                                      v
                              Gemini LLM -> Answer
```

## Key Features

- GitHub OAuth with authenticated repository access.
- Repository-scoped semantic retrieval using Pinecone namespaces.
- Language-aware code chunking for major programming languages.
- `gemini-embedding-001` embeddings with 1536-dimensional vectors.
- Persistent project summaries covering architecture, dependencies, data flow, and implementation decisions.
- Compact chat summaries preserving requirements, decisions, unresolved issues, and repository context.
- Redis caching with a 24-hour TTL for repository metadata and summaries.
- Node.js/Express backend integrated with Python RAG components.
- MongoDB-backed sessions for persistent authentication state.

## Tech Stack

**Backend:** Node.js, Express, Passport, GitHub OAuth  
**RAG:** Python, LangChain, Google Gemini, Pinecone  
**Storage:** MongoDB, Redis, Pinecone  
**Frontend:** HTML, CSS, JavaScript

## RAG Pipeline

1. Authenticate with GitHub and select a repository.
2. Fetch repository structure and relevant source files.
3. Split code using language-aware recursive chunking.
4. Generate embeddings and index chunks in a repository-specific Pinecone namespace.
5. Embed the user query and retrieve relevant code chunks.
6. Combine retrieved code with project and conversational context.
7. Generate the response with Gemini.
8. Update persistent summaries for future conversations.

## Project Structure

```text
Project_Building_RAG/
├── backend/
│   ├── api.js              # GitHub APIs and repository handling
│   ├── auth.js             # GitHub OAuth and authentication
│   ├── chat.js             # RAG orchestration and Redis caching
│   └── index.js             # Express entry point
├── RAG_Components/
│   ├── chunker.py          # Language-aware code chunking
│   ├── embedding.py        # Embedding generation
│   ├── pinecone_db.py      # Pinecone connection
│   ├── vector_store.py     # Vector ingestion and namespacing
│   ├── retriver.py         # Similarity retrieval
│   ├── rag_index.py        # RAG ingestion and query pipeline
│   ├── project_summary.py  # Project context generation
│   ├── chat_summary.py     # Conversational memory generation
│   └── send_to_llm.py      # LLM response generation
├── frontend/
│   └── homepage.html
├── package.json
└── requirements.txt
```

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.x
- MongoDB
- Redis
- Pinecone
- Google Gemini API access
- GitHub OAuth application

### Install

```bash
git clone https://github.com/anandanku/Project_Building_RAG.git
cd Project_Building_RAG
npm install
pip install -r requirements.txt
```

Configure the required environment variables for MongoDB, Redis, Pinecone, Gemini, GitHub OAuth, sessions, and the Python runtime in `.env`.

```bash
npm start
```

Development mode:

```bash
npm run dev
```

## Engineering Focus

This project goes beyond a basic chatbot by addressing practical RAG concerns: repository isolation, code-aware chunking, persistent context, conversational memory, caching, authentication, external API integration, and a Node.js/Python service boundary.

## Status

Actively developed with ongoing work on retrieval quality, context management, caching, and end-to-end frontend/backend integration.

## Author

Ayush Anand | NIT Raipur
