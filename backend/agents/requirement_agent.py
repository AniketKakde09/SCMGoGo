from utlis.json_parser import parse_json
from services.llm import call_llm
from prompts.requirement_prompt import REQUIREMENT_AGENT_PROMPT

def run(state: dict) -> dict:
    print("\n============= Requirement Stage =============")
    
    prompt = f"""
    {REQUIREMENT_AGENT_PROMPT}
    Requirement:

    {state.get('parsed_text', '')}
    """
    
    try:
        response = call_llm(
            prompt,
            json_mode=True
        )

        result = parse_json(response)

        state["goal"] = result.get("goal", "")
        state["scope"] = result.get("scope", "")
        state["requirements"] = result.get("functional_requirements", [])
        state["non_functional_requirements"] = result.get(
            "non_functional_requirements",
            []
        )
        state["constraints"] = result.get("constraints", [])
        state["dependencies"] = result.get("dependencies", [])
        state["personas"] = result.get("personas", [])

        # -------------------------------------------------
        # Assumptions
        # -------------------------------------------------
        assumptions = result.get("assumptions", [])
        state["assumptions"] = []

        for item in assumptions:
            if not isinstance(item, dict):
                continue

            assumption = item.get("assumption", "")
            if assumption:
                state["assumptions"].append(assumption)

        print("\n========== REQUIREMENT SUMMARY ==========")
        print(f"Goal         : {state['goal']}")
        print(f"Scope        : {state['scope']}")
        print(f"Requirements : {len(state['requirements'])}")
        print(f"Assumptions  : {len(state['assumptions'])}")
        print("=========================================")

    except Exception as error:
        print(f"Requirement stage failed: {error}")
        state["error"] = "Requirement extraction failed."

    return state