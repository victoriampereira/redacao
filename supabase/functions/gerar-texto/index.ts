// Redação — gera ofícios, e-mails e mensagens com o Gemini, lendo fotos e PDFs da pasta.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const GEMINI = "https://generativelanguage.googleapis.com";
const MODELOS: Record<string, string[]> = {
  caprichado: (Deno.env.get("GEMINI_MODELO_CAPRICHADO") ?? "gemini-flash-latest,gemini-flash-lite-latest").split(","),
  rapido: (Deno.env.get("GEMINI_MODELO_RAPIDO") ?? "gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(","),
};
const NOMES: Record<string, string> = {
  oficio_interno: "Ofício interno",
  oficio_externo: "Ofício externo",
  email: "E-mail",
  whatsapp: "Mensagem de WhatsApp",
  livre: "Texto livre",
};
const LIMITE_INLINE = 14 * 1024 * 1024; // acima disso, envia pela File API

function b64(buf: Uint8Array) {
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function enviarArquivoGemini(key: string, bytes: Uint8Array, mime: string, nome: string) {
  const ini = await fetch(`${GEMINI}/upload/v1beta/files?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: nome.slice(0, 120) } }),
  });
  const url = ini.headers.get("x-goog-upload-url");
  if (!url) throw new Error("Falha ao enviar arquivo ao Gemini: " + (await ini.text()));
  const up = await fetch(url, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
  });
  const info = await up.json();
  let file = info.file;
  for (let i = 0; i < 30 && file?.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    file = await (await fetch(`${GEMINI}/v1beta/${file.name}?key=${key}`)).json();
  }
  if (!file?.uri) throw new Error("O Gemini não aceitou o arquivo " + nome);
  return file.uri as string;
}

function montarInstrucoes(tipo: string, cfg: any, modelo: any) {
  const ano = new Date().getFullYear();
  const dados = [
    cfg?.nome && `Nome: ${cfg.nome}`,
    cfg?.cargo && `Cargo: ${cfg.cargo}`,
    cfg?.orgao && `Órgão/Empresa: ${cfg.orgao}`,
    cfg?.setor && `Setor: ${cfg.setor}`,
    cfg?.cidade && `Cidade: ${cfg.cidade}`,
    cfg?.contato && `Contato: ${cfg.contato}`,
  ].filter(Boolean).join("\n");
  return `Você é a assistente de redação pessoal da usuária. Escreve em português do Brasil, com clareza, objetividade e correção, no padrão de redação oficial quando for ofício.

Regras gerais:
- Entregue somente o texto final pronto para copiar e colar fora do app. Nada de comentários, explicações, alternativas ou "aqui está".
- Não use Markdown (sem **, #, listas com hífen) em ofícios e e-mails. Use quebras de linha simples entre parágrafos.
- Em WhatsApp, pode usar *negrito* com asteriscos só se ajudar, e emojis apenas se a usuária pedir.
- Nunca invente fatos, datas, valores, números de contrato ou nomes. Use o que estiver no pedido e nos anexos. Se faltar uma informação essencial, deixe um marcador entre colchetes, como [data da reunião].
- Quando houver fotos ou PDFs, leia com atenção e use as informações relevantes (cláusulas, prazos, valores, nomes, números). Cite cláusulas e documentos quando fortalecer o texto.
- Ano atual: ${ano}. Data de hoje: ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "numeric", month: "long", year: "numeric" })}.
${cfg?.regras_gerais ? "\nRegras da usuária (têm prioridade):\n" + cfg.regras_gerais + "\n" : ""}
Dados fixos da usuária (use na assinatura, cabeçalho e identificação):
${dados || "(não preenchidos — deixe marcadores [nome], [cargo])"}

Tipo de texto pedido: ${NOMES[tipo] ?? tipo}

Padrão para este tipo:
${modelo?.instrucoes || "(sem instruções específicas)"}
${modelo?.exemplo ? "\nExemplo real do padrão desejado (siga estrutura, tom e formatação; não copie o conteúdo):\n<<<\n" + modelo.exemplo + "\n>>>" : ""}

Responda em JSON com os campos: "titulo" (resumo de 3 a 7 palavras para o histórico) e "texto" (o texto final).`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) return json({ erro: "A chave do Gemini ainda não foi cadastrada no Supabase (segredo GEMINI_API_KEY)." }, 400);

    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({ erro: "Sessão expirada. Entre de novo." }, 401);

    const b = await req.json();
    const tipo: string = b.tipo ?? "livre";
    const qualidade: string = b.qualidade === "caprichado" ? "caprichado" : "rapido";
    const ids: string[] = Array.isArray(b.arquivo_ids) ? b.arquivo_ids.slice(0, 40) : [];

    const [{ data: cfg }, { data: modelo }, { data: arqs }] = await Promise.all([
      sb.from("red_config").select("*").maybeSingle(),
      sb.from("red_modelos").select("*").eq("tipo", tipo).maybeSingle(),
      ids.length ? sb.from("red_arquivos").select("*").in("id", ids) : Promise.resolve({ data: [] as any[] }),
    ]);

    // Anexos
    const partes: any[] = [];
    let inline = 0;
    for (const a of arqs ?? []) {
      const valido = a.gemini_uri && a.gemini_expira && new Date(a.gemini_expira).getTime() > Date.now() + 3600_000;
      if (valido) {
        partes.push({ text: `Anexo: ${a.nome}` }, { fileData: { mimeType: a.mime, fileUri: a.gemini_uri } });
        continue;
      }
      const { data: blob, error } = await sb.storage.from("redacao").download(a.caminho);
      if (error || !blob) throw new Error("Não consegui abrir o anexo " + a.nome);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (inline + bytes.length <= LIMITE_INLINE) {
        inline += bytes.length;
        partes.push({ text: `Anexo: ${a.nome}` }, { inlineData: { mimeType: a.mime, data: b64(bytes) } });
      } else {
        const uri = await enviarArquivoGemini(key, bytes, a.mime, a.nome);
        await sb.from("red_arquivos").update({ gemini_uri: uri, gemini_expira: new Date(Date.now() + 47 * 3600_000).toISOString() }).eq("id", a.id);
        partes.push({ text: `Anexo: ${a.nome}` }, { fileData: { mimeType: a.mime, fileUri: uri } });
      }
    }

    let pedido = "";
    if (b.destinatario) pedido += `Destinatário: ${b.destinatario}\n`;
    if (b.numero && tipo.startsWith("oficio")) pedido += `Número do ofício: ${b.numero}\n`;
    pedido += `O que precisa ser escrito:\n${b.pedido ?? ""}`;
    if (b.texto_anterior && b.ajuste) {
      pedido += `\n\nVersão anterior do texto:\n<<<\n${b.texto_anterior}\n>>>\n\nReescreva aplicando este ajuste, mantendo o resto: ${b.ajuste}`;
    }

    const corpo = {
      systemInstruction: { parts: [{ text: montarInstrucoes(tipo, cfg, modelo) }] },
      contents: [{ role: "user", parts: [...partes, { text: pedido }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { titulo: { type: "STRING" }, texto: { type: "STRING" } },
          required: ["titulo", "texto"],
        },
      },
    };

    let ultimoErro = "";
    let limite = false;
    for (const m of MODELOS[qualidade]) {
      const r = await fetch(`${GEMINI}/v1beta/models/${m.trim()}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      if (r.status === 429) { limite = true; ultimoErro = "limite"; continue; }
      if (r.status === 404) { ultimoErro = "modelo indisponível: " + m; continue; }
      const d = await r.json();
      if (!r.ok) { ultimoErro = d?.error?.message ?? "erro " + r.status; if (r.status >= 500) continue; break; }
      const bruto = d?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      let titulo = "", texto = bruto;
      try { const o = JSON.parse(bruto); titulo = o.titulo ?? ""; texto = o.texto ?? bruto; } catch { /* usa bruto */ }
      if (!texto.trim()) { ultimoErro = "O Gemini devolveu uma resposta vazia (pode ter bloqueado o conteúdo)."; continue; }
      return json({ titulo, texto: texto.trim(), modelo: m.trim(), uso: d.usageMetadata ?? null });
    }
    if (limite) return json({ erro: "O limite gratuito do Gemini foi atingido por agora. Espere um minuto (ou até amanhã, se for o limite diário) ou troque para o modo Rápido." }, 429);
    return json({ erro: "O Gemini não conseguiu gerar o texto. " + ultimoErro }, 502);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
