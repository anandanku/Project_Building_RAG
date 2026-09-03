from pinecone import Pinecone, ServerlessSpec
from dotenv import load_dotenv
load_dotenv()
pc=Pinecone()
index_name="github-rag"
ED=1536

if index_name not in pc.list_indexes().names():
    pc.create_index(
        name=index_name,
        dimension=ED,
        metric="cosine",
        spec=ServerlessSpec(
            cloud="aws",
            region="ap-south-1"
        )
    )
index=pc.Index(index_name)