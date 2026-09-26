import os
from openai import OpenAI

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "dummy-key"))

def generate_pe_proposal(buyer_name: str, target_count: int, sector: str) -> str:
    prompt = f"""
    You are a buy-side M&A advisor at Mergero. Write a short, professional proposal email to an investment director at private equity fund {buyer_name}.
    
    Context:
    - Sector of interest: {sector}
    - Off-market targets currently identified matching their criteria: {target_count}
    
    Tone requirements:
    - Direct, commercial, deal-focused, and non-ceremonial.
    - Highlight Mergero's proprietary off-market access via the MGX engine rather than public auctions.
    - Keep it under 150 words.
    """
    
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7
        )
        return response.choices[0].message.content
    except Exception:
        return f"Hi, we have identified {target_count} off-market targets in the {sector} space matching {buyer_name}'s acquisition criteria. Let's review the proprietary pipeline."
