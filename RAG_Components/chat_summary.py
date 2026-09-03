import json
import sys

from dotenv import load_dotenv
from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI

load_dotenv()

# Keep this model consistent with the existing RAG pipeline.
llm = ChatGoogleGenerativeAI(
    model="gemini-3.7-flash",
    temperature=0.1,
)

prompt = ChatPromptTemplate.from_template(
    """
You maintain persistent conversational memory for a software-project RAG
assistant.

The memory belongs to ONE user + ONE repository. Update the existing summary
using the latest user question and the assistant's latest answer.

================ REPOSITORY STRUCTURE ================

{repository_structure}

================ PREVIOUS CHAT SUMMARY ================

{previous_chat_summary}

================ CURRENT USER QUESTION ================

{current_query}

================ CURRENT ASSISTANT ANSWER ================

{current_answer}

================ INSTRUCTIONS ================

Create the UPDATED chat summary.

The summary should preserve only information that can improve future
conversation quality, such as:

- the user's current goal or task;
- important requirements and constraints stated by the user;
- decisions the user has made;
- implementation choices discussed;
- important questions that were answered;
- unresolved issues or next steps;
- repository-specific context that was established during the conversation;
- corrections to earlier assumptions.

Do NOT:
- repeat the full conversation;
- preserve greetings, filler, or irrelevant small talk;
- invent facts;
- store secrets, access tokens, passwords, or other credentials;
- copy large code blocks;
- allow stale information to survive when the latest conversation clearly
  corrects it.

The repository structure is supporting context only. Do not turn the entire
repository tree into chat memory.

Keep the result compact and information-dense. Use short headings and bullets.
Preserve important technical names such as file names, functions, Redis keys,
or API concepts when they matter for future questions.

If there is no previous summary, create one from the current interaction.

Return ONLY the updated summary text.

Updated chat summary:
"""
)

chain = prompt | llm


def generate_chat_summary(
    repository_structure,
    previous_chat_summary,
    current_query,
    current_answer,
):
    """
    Update the persistent chat summary for one user/repository pair.

    Args:
        repository_structure: Current repository structure.
        previous_chat_summary: Previously stored summary, or empty string.
        current_query: Latest user question.
        current_answer: Latest assistant answer.

    Returns:
        str: Updated chat summary.
    """
    if not current_query:
        raise ValueError("current_query is required")

    if not current_answer:
        raise ValueError("current_answer is required")

    response = chain.invoke(
        {
            "repository_structure": repository_structure or "",
            "previous_chat_summary": previous_chat_summary or "",
            "current_query": current_query,
            "current_answer": current_answer,
        }
    )

    summary = response.content

    if isinstance(summary, list):
        summary = "\n".join(
            item.get("text", str(item))
            if isinstance(item, dict)
            else str(item)
            for item in summary
        )

    summary = str(summary).strip()

    if not summary:
        raise ValueError("LLM returned an empty chat summary")

    return summary


def main():
    """
    Node.js sends JSON through stdin and expects JSON through stdout.
    """
    try:
        payload = json.load(sys.stdin)

        summary = generate_chat_summary(
            repository_structure=payload.get("repository_structure", ""),
            previous_chat_summary=payload.get("previous_chat_summary", ""),
            current_query=payload.get("current_query", ""),
            current_answer=payload.get("current_answer", ""),
        )

        print(
            json.dumps(
                {"summary": summary},
                ensure_ascii=False,
            )
        )

    except Exception as error:
        print(
            json.dumps(
                {"error": str(error)},
                ensure_ascii=False,
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
