from langchain_google_genai import GoogleGenerativeAIEmbeddings
from dotenv import load_dotenv
load_dotenv()

embeddings=GoogleGenerativeAIEmbeddings(model="gemini-embedding-001",output_dimensionality=1536)

def generate_embedding(text):
    return embeddings.embed_query(text)
