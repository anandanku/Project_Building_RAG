from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.prompts import ChatPromptTemplate
from dotenv import load_dotenv

load_dotenv()


llm = ChatGoogleGenerativeAI(
    model="gemini-3.7-flash",
    temperature=0.2
)


prompt = ChatPromptTemplate.from_template(
    """
You are a helpful AI assistant who guides students through their software projects.

You have access to the following information about the user's project.

================ PROJECT CONTEXT ================

{project_context}

================ REPOSITORY STRUCTURE ================

{repository_structure}

================ RELEVANT CODE ================

{relevant_files}

================ PREVIOUS CHAT CONTEXT ================

{summarized_chat_history}

================ USER QUERY ================

{query}

Answer the user's question using the provided project context,
repository structure, relevant code, and previous chat context.

Do not invent information about the repository.
If the provided information is insufficient, clearly say that
you don't have enough repository context to determine the answer.

Give a clear and useful answer suitable for a student.

Answer:
"""
)


def retrieve_info(
    project_context,
    repository_structure,
    relevant_files,
    summarized_chat_history,
    query
):

    final_pipe = prompt | llm

    response = final_pipe.invoke({
        "project_context": project_context,
        "repository_structure": repository_structure,
        "relevant_files": relevant_files,
        "summarized_chat_history": summarized_chat_history,
        "query": query
    })

    return response.content