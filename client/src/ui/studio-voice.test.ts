// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE,
  loadVoiceConfig,
  saveVoiceConfig,
  speechText,
  VoiceClient,
  VoicePlayer,
  VoiceRecorder,
  type VoiceConfig,
} from './studio-voice';

function storageWith(value: unknown): Pick<Storage, 'getItem'> {
  return {
    getItem: (key) => {
      expect(key).toBe('habblaud_studio_v1:voice');
      return JSON.stringify(value) ?? null;
    },
  };
}

interface CapturedRequest {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetcher: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    return respond();
  };

  return { fetcher, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestForm(request: CapturedRequest): FormData {
  const body = request.init?.body;
  if (!(body instanceof FormData)) {
    throw new Error('Era esperado um formulário multipart.');
  }
  return body;
}

function requestJson(request: CapturedRequest): unknown {
  const body = request.init?.body;
  if (typeof body !== 'string') {
    throw new Error('Era esperado um corpo JSON.');
  }
  return JSON.parse(body);
}

describe('loadVoiceConfig', () => {
  it('usa o padrão sem armazenamento ou sem chave salva', () => {
    expect(loadVoiceConfig(undefined)).toEqual(DEFAULT_VOICE);
    expect(loadVoiceConfig({ getItem: () => null })).toEqual(DEFAULT_VOICE);
    expect(loadVoiceConfig(undefined)).not.toBe(DEFAULT_VOICE);
  });

  it('descarta JSON inválido e valores que não são objetos', () => {
    expect(loadVoiceConfig({ getItem: () => '{inválido' })).toEqual(DEFAULT_VOICE);

    for (const value of [null, false, 12, 'lixo', [], ['localhost']]) {
      expect(loadVoiceConfig(storageWith(value))).toEqual(DEFAULT_VOICE);
    }
  });

  it('valida os campos separadamente e descarta campos desconhecidos', () => {
    expect(
      loadVoiceConfig(
        storageWith({
          base: 42,
          sttModel: 'motor-stt',
          ttsModel: [],
          voice: null,
          speak: 'true',
          desconhecido: 'descartar',
        }),
      ),
    ).toEqual({
      ...DEFAULT_VOICE,
      sttModel: 'motor-stt',
    });
  });

  it('preserva campos válidos', () => {
    const cfg: VoiceConfig = {
      base: 'https://localhost:3900',
      sttModel: 'motor-stt',
      ttsModel: 'motor-tts',
      voice: 'voz-local',
      speak: true,
    };

    expect(loadVoiceConfig(storageWith(cfg))).toEqual(cfg);
  });

  it('rejeita bases remotas, esquemas inadequados e credenciais', () => {
    for (const base of [
      'https://exemplo.com',
      'http://192.168.1.10:3900',
      'http://localhost.exemplo.com',
      'http://localhost@exemplo.com',
      'http://usuario:senha@localhost:3900',
      'ftp://localhost:3900',
      '//localhost:3900',
      'endereço inválido',
    ]) {
      expect(loadVoiceConfig(storageWith({ base })).base).toBe(DEFAULT_VOICE.base);
    }
  });

  it('aceita os endereços locais permitidos', () => {
    for (const base of [
      'http://127.0.0.1:3900',
      'http://localhost:3900',
      'https://localhost:3900',
      'http://[::1]:3900',
    ]) {
      expect(loadVoiceConfig(storageWith({ base })).base).toBe(base);
    }
  });

  it('tolera armazenamento bloqueado', () => {
    expect(
      loadVoiceConfig({
        getItem: () => {
          throw new Error('Armazenamento bloqueado.');
        },
      }),
    ).toEqual(DEFAULT_VOICE);
  });
});

describe('saveVoiceConfig', () => {
  it('salva apenas a configuração validada na chave esperada', () => {
    let saved: string | undefined;

    saveVoiceConfig(
      {
        setItem: (key, value) => {
          expect(key).toBe('habblaud_studio_v1:voice');
          saved = value;
        },
      },
      { ...DEFAULT_VOICE, base: 'https://exemplo.com', speak: true },
    );

    expect(JSON.parse(saved ?? '{}')).toEqual({
      ...DEFAULT_VOICE,
      speak: true,
    });
  });

  it('tolera ausência ou bloqueio do armazenamento', () => {
    expect(() => saveVoiceConfig(undefined, DEFAULT_VOICE)).not.toThrow();
    expect(() =>
      saveVoiceConfig(
        {
          setItem: () => {
            throw new Error('Armazenamento bloqueado.');
          },
        },
        DEFAULT_VOICE,
      ),
    ).not.toThrow();
  });
});

describe('speechText', () => {
  it('substitui blocos de código pelo aviso', () => {
    expect(
      speechText('Antes.\n```ts\nconst segredo = 123;\n```\nDepois.'),
    ).toBe('Antes. (código omitido) Depois.');

    expect(speechText('Antes ```código``` depois')).toBe(
      'Antes (código omitido) depois',
    );
  });

  it('omite também um bloco ainda não fechado', () => {
    expect(speechText('Veja:\n```ts\nconst valor = 1;')).toBe(
      'Veja: (código omitido)',
    );
  });

  it('mantém o conteúdo inline e remove marcações', () => {
    expect(speechText('# Título\n> Use `const valor = 1` com **calma** e _atenção_.'))
      .toBe('Título Use const valor = 1 com calma e atenção.');
  });

  it('mantém o rótulo dos links e substitui URLs soltas', () => {
    expect(
      speechText(
        'Veja [a documentação](https://exemplo.com/docs) e https://exemplo.com/teste.',
      ),
    ).toBe('Veja a documentação e link.');
  });

  it('colapsa espaços e corta no fim de uma frase quando possível', () => {
    expect(speechText('  Olá.\n\n Tudo   bem?  ')).toBe('Olá. Tudo bem?');
    expect(speechText('Primeira frase. Segunda frase muito longa.', 25)).toBe(
      'Primeira frase.',
    );
  });

  it('respeita o limite mesmo sem frase completa', () => {
    expect(speechText('Uma mensagem longa demais', 12)).toBe('Uma mensagem');
    expect(speechText('abcdefghij', 4)).toBe('abcd');
    expect(speechText('Olá.', 0)).toBe('');
    expect(speechText('Olá.', -1)).toBe('');
    expect(speechText('a'.repeat(1300))).toHaveLength(1200);
  });
});

describe('VoiceClient', () => {
  it('consulta a saúde com timeout e retorna true para sucesso', async () => {
    const { fetcher, requests } = fakeFetch(() => new Response(null));
    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);

    await expect(client.available()).resolves.toBe(true);
    expect(requests[0].input).toBe('http://127.0.0.1:3900/health');
    expect(requests[0].init?.method).toBe('GET');
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0].init?.redirect).toBe('error');
  });

  it('retorna false para erro HTTP ou erro de rede', async () => {
    const http = fakeFetch(() => new Response(null, { status: 503 }));
    const network = fakeFetch(() => {
      throw new Error('Falha de rede.');
    });

    await expect(
      new VoiceClient(() => ({ ...DEFAULT_VOICE }), http.fetcher).available(),
    ).resolves.toBe(false);

    await expect(
      new VoiceClient(() => ({ ...DEFAULT_VOICE }), network.fetcher).available(),
    ).resolves.toBe(false);
  });

  it('combina o cancelamento externo com o sinal de timeout', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;

    const fetcher: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal;

      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          'abort',
          () => reject(new Error('Consulta cancelada.')),
          { once: true },
        );
      });
    };

    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);
    const result = client.available(controller.signal);

    expect(receivedSignal).not.toBe(controller.signal);
    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('envia multipart em português sem modelo vazio', async () => {
    const { fetcher, requests } = fakeFetch(() =>
      jsonResponse({ text: '  Crie um teste. \n' }),
    );
    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);
    const audio = new Blob(['áudio de teste'], { type: 'audio/webm;codecs=opus' });
    const controller = new AbortController();

    await expect(client.transcribe(audio, controller.signal)).resolves.toBe(
      'Crie um teste.',
    );

    const request = requests[0];
    const form = requestForm(request);
    const file = form.get('file');

    expect(request.input).toBe('http://127.0.0.1:3900/v1/audio/transcriptions');
    expect(request.init?.method).toBe('POST');
    expect(request.init?.signal).toBe(controller.signal);
    expect(request.init?.headers).toBeUndefined();
    expect(request.init?.redirect).toBe('error');
    expect(form.get('language')).toBe('pt');
    expect(form.get('response_format')).toBe('json');
    expect(form.has('model')).toBe(false);
    expect(file).toBeInstanceOf(Blob);
    expect(file).toHaveProperty('name', 'fala.webm');

    if (!(file instanceof Blob)) throw new Error('O arquivo de áudio está ausente.');
    expect(await file.text()).toBe('áudio de teste');
  });

  it('envia o modelo STT configurado e escolhe a extensão pelo tipo', async () => {
    const { fetcher, requests } = fakeFetch(() => jsonResponse({ text: 'Pronto.' }));
    const client = new VoiceClient(
      () => ({ ...DEFAULT_VOICE, sttModel: 'motor-stt' }),
      fetcher,
    );

    await client.transcribe(new Blob(['áudio'], { type: 'audio/ogg' }));

    const form = requestForm(requests[0]);
    expect(form.get('model')).toBe('motor-stt');
    expect(form.get('file')).toHaveProperty('name', 'fala.ogg');
  });

  it('inclui error.message na mensagem de transcrição', async () => {
    const { fetcher } = fakeFetch(() =>
      jsonResponse({ error: { message: 'Motor indisponível' } }, 503),
    );
    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);

    await expect(client.transcribe(new Blob())).rejects.toThrow(
      'Não foi possível transcrever o áudio: Motor indisponível',
    );
  });

  it('rejeita uma transcrição sem texto', async () => {
    const { fetcher } = fakeFetch(() => jsonResponse({ resultado: 'inválido' }));
    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);

    await expect(client.transcribe(new Blob())).rejects.toThrow(
      'O VoiceStudio devolveu uma transcrição sem texto.',
    );
  });

  it('sintetiza em MP3 sem enviar modelo ou voz vazios', async () => {
    const { fetcher, requests } = fakeFetch(
      () => new Response('áudio mp3', { headers: { 'Content-Type': 'audio/mpeg' } }),
    );
    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);
    const controller = new AbortController();

    const result = await client.synthesize('  Olá!  ', controller.signal);

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('audio/mpeg');
    expect(await result.text()).toBe('áudio mp3');
    expect(requests[0].input).toBe('http://127.0.0.1:3900/v1/audio/speech');
    expect(requests[0].init?.method).toBe('POST');
    expect(requests[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(requests[0].init?.signal).toBe(controller.signal);
    expect(requests[0].init?.redirect).toBe('error');
    expect(requestJson(requests[0])).toEqual({
      input: 'Olá!',
      response_format: 'mp3',
    });
  });

  it('envia modelo TTS e voz configurados', async () => {
    const { fetcher, requests } = fakeFetch(() => new Response('áudio'));
    const client = new VoiceClient(
      () => ({
        ...DEFAULT_VOICE,
        ttsModel: 'motor-tts',
        voice: 'voz-local',
      }),
      fetcher,
    );

    await client.synthesize('Tudo pronto.');

    expect(requestJson(requests[0])).toEqual({
      input: 'Tudo pronto.',
      response_format: 'mp3',
      model: 'motor-tts',
      voice: 'voz-local',
    });
  });

  it('não faz requisição para texto vazio', async () => {
    const { fetcher, requests } = fakeFetch(() => new Response('áudio'));
    const client = new VoiceClient(() => ({ ...DEFAULT_VOICE }), fetcher);

    await expect(client.synthesize(' \n ')).rejects.toThrow(
      'Informe um texto para gerar a fala.',
    );
    expect(requests).toHaveLength(0);
  });

  it('usa detail e oferece mensagem alternativa para erro sem JSON', async () => {
    const detail = fakeFetch(() =>
      jsonResponse({ detail: 'Voz não instalada' }, 400),
    );
    const plain = fakeFetch(() => new Response('Falha', { status: 500 }));

    await expect(
      new VoiceClient(() => ({ ...DEFAULT_VOICE }), detail.fetcher).synthesize('Olá'),
    ).rejects.toThrow('Não foi possível gerar a fala: Voz não instalada');

    await expect(
      new VoiceClient(() => ({ ...DEFAULT_VOICE }), plain.fetcher).synthesize('Olá'),
    ).rejects.toThrow('Não foi possível gerar a fala: erro HTTP 500');
  });

  it('revalida a base recebida diretamente e lê a configuração a cada chamada', async () => {
    const { fetcher, requests } = fakeFetch(() => new Response(null));
    let cfg = { ...DEFAULT_VOICE, base: 'https://exemplo.com' };
    const client = new VoiceClient(() => cfg, fetcher);

    await client.available();
    cfg = { ...cfg, base: 'http://localhost:3900' };
    await client.available();

    expect(requests[0].input).toBe('http://127.0.0.1:3900/health');
    expect(requests[1].input).toBe('http://localhost:3900/health');
  });
});

describe('construção fora do navegador', () => {
  it('constrói gravador e reprodutor sem acessar APIs do navegador', () => {
    expect(() => new VoiceRecorder()).not.toThrow();
    expect(() => new VoicePlayer()).not.toThrow();
  });
});
