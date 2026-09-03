from langchain_text_splitters import (
    RecursiveCharacterTextSplitter,
    Language
)


def get_lang(file_name):
    extension = file_name.split(".")[-1].lower()

    language_map = {
        "py": Language.PYTHON,
        "js": Language.JS,
        "jsx": Language.JS,
        "ts": Language.TS,
        "tsx": Language.TS,
        "java": Language.JAVA,
        "cpp": Language.CPP,
        "c": Language.C,
        "go": Language.GO,
        "rs": Language.RUST
    }

    return language_map.get(extension)


def chunker(code, github_id, repo_id, file_name):
    language = get_lang(file_name)

    if language is not None:
        splitter = RecursiveCharacterTextSplitter.from_language(
            language=language,
            chunk_size=500,
            chunk_overlap=50
        )
        language_name = language.value
    else:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=500,
            chunk_overlap=50
        )
        language_name = file_name.split(".")[-1].lower()

    chunks = splitter.create_documents(
        [code],
        metadatas=[
            {
                "github_id": github_id,
                "repo_id": repo_id,
                "language": language_name,
                "file_name": file_name
            }
        ]
    )

    for index, chunk in enumerate(chunks):
        chunk.metadata["chunk_index"] = index

    return chunks
