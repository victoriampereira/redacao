# Redação

Assistente pessoal para escrever ofícios internos e externos, e-mails e mensagens de WhatsApp no padrão, lendo fotos e PDFs.

- Página: GitHub Pages (este repositório)
- Dados, arquivos e login: Supabase (tabelas `red_*`, bucket privado `redacao`)
- IA: Gemini, pela função `supabase/functions/gerar-texto` (a chave fica no segredo `GEMINI_API_KEY` do Supabase, nunca no código)
