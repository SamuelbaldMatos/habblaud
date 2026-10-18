export interface VoiceConfig {
  base: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  speak: boolean;
}

export const DEFAULT_VOICE: VoiceConfig = {
  base: 'http://127.0.0.1:3900',
  sttModel: '',
  ttsModel: '',
  voice: '',
  speak: false,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localBase(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_VOICE.base;

  try {
    const url = new URL(value.trim());
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const http = url.protocol === 'http:' || url.protocol === 'https:';

    if (local && http && !url.username && !url.password) {
      return value.trim().replace(/\/+$/, '');
    }
  } catch {
    // Uma configuração inválida nunca deve enviar voz para outro servidor.
  }

  return DEFAULT_VOICE.base;
}

function normalizeConfig(value: unknown): VoiceConfig {
  const cfg = isObject(value) ? value : {};

  return {
    base: localBase(cfg.base),
    sttModel: typeof cfg.sttModel === 'string' ? cfg.sttModel : DEFAULT_VOICE.sttModel,
    ttsModel: typeof cfg.ttsModel === 'string' ? cfg.ttsModel : DEFAULT_VOICE.ttsModel,
    voice: typeof cfg.voice === 'string' ? cfg.voice : DEFAULT_VOICE.voice,
    speak: typeof cfg.speak === 'boolean' ? cfg.speak : DEFAULT_VOICE.speak,
  };
}

export function loadVoiceConfig(
  storage: Pick<Storage, 'getItem'> | undefined,
): VoiceConfig {
  try {
    const raw = storage?.getItem('habblaud_studio_v1:voice');
    return normalizeConfig(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_VOICE };
  }
}

export function saveVoiceConfig(
  storage: Pick<Storage, 'setItem'> | undefined,
  cfg: VoiceConfig,
): void {
  try {
    storage?.setItem(
      'habblaud_studio_v1:voice',
      JSON.stringify(normalizeConfig(cfg)),
    );
  } catch {
    // A indisponibilidade do armazenamento não deve impedir o uso da voz.
  }
}

export function speechText(markdown: string, max = 1200): string {
  const text = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, ' (código omitido) ')
    .replace(/`+([^`]*?)`+/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/[^\s<>()]+/gi, (url) => {
      const punctuation = url.match(/[.,!?;:]+$/)?.[0] ?? '';
      return `link${punctuation}`;
    })
    .replace(/[#*_>~`]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 1200;
  if (text.length <= limit) return text;

  const prefix = text.slice(0, limit);
  let sentenceEnd = 0;

  for (const match of prefix.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index + 1;
    // Não confundir um ponto no meio de uma palavra cortada com fim de frase.
    if (end < limit || /\s/.test(text.charAt(end))) sentenceEnd = end;
  }

  if (sentenceEnd > 0) return prefix.slice(0, sentenceEnd).trim();

  // O corte caiu logo antes de um espaço: a última palavra está inteira.
  if (/\s/.test(text.charAt(limit))) return prefix.trim();
  const wordEnd = prefix.lastIndexOf(' ');
  return (wordEnd > 0 ? prefix.slice(0, wordEnd) : prefix).trim();
}

async function responseError(response: Response, message: string): Promise<Error> {
  let detail = '';

  try {
    const body: unknown = await response.json();
    if (isObject(body)) {
      if (isObject(body.error) && typeof body.error.message === 'string') {
        detail = body.error.message.trim();
      }
      if (!detail && typeof body.detail === 'string') {
        detail = body.detail.trim();
      }
    }
  } catch {
    // Alguns erros HTTP chegam sem JSON.
  }

  return new Error(`${message}: ${detail || `erro HTTP ${response.status}`}.`);
}

function audioFilename(type: string): string {
  switch (type.split(';')[0].trim().toLowerCase()) {
    case 'audio/ogg':
      return 'fala.ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'fala.wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'fala.mp3';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'fala.m4a';
    case 'audio/flac':
      return 'fala.flac';
    default:
      return 'fala.webm';
  }
}

export class VoiceClient {
  constructor(
    private cfg: () => VoiceConfig,
    // Envolvido numa função: chamar `this.fetcher(...)` com o fetch nativo daria "Illegal invocation" no navegador.
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private endpoint(base: string, path: string): string {
    // A validação também protege configurações fornecidas sem passar pelo storage.
    return new URL(path, localBase(base)).href;
  }

  async available(signal?: AbortSignal): Promise<boolean> {
    let cleanup = (): void => {};

    try {
      const timeout = AbortSignal.timeout(2000);
      let combined: AbortSignal = timeout;

      if (signal) {
        const controller = new AbortController();
        const abort = (): void => controller.abort();

        timeout.addEventListener('abort', abort, { once: true });
        signal.addEventListener('abort', abort, { once: true });

        cleanup = () => {
          timeout.removeEventListener('abort', abort);
          signal.removeEventListener('abort', abort);
        };

        if (timeout.aborted || signal.aborted) abort();
        combined = controller.signal;
      }

      const response = await this.fetcher(
        this.endpoint(this.cfg().base, '/health'),
        {
          method: 'GET',
          signal: combined,
          redirect: 'error',
        },
      );

      return response.ok;
    } catch {
      return false;
    } finally {
      cleanup();
    }
  }

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    const cfg = this.cfg();
    const form = new FormData();

    form.append('file', audio, audioFilename(audio.type));
    form.append('language', 'pt');
    form.append('response_format', 'json');
    if (cfg.sttModel.trim()) form.append('model', cfg.sttModel.trim());

    const response = await this.fetcher(
      this.endpoint(cfg.base, '/v1/audio/transcriptions'),
      {
        method: 'POST',
        body: form,
        signal,
        // Impede que um redirecionamento encaminhe o áudio para fora do PC.
        redirect: 'error',
      },
    );

    if (!response.ok) {
      throw await responseError(response, 'Não foi possível transcrever o áudio');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('O VoiceStudio devolveu uma transcrição inválida.');
    }

    if (!isObject(body) || typeof body.text !== 'string') {
      throw new Error('O VoiceStudio devolveu uma transcrição sem texto.');
    }

    return body.text.trim();
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Blob> {
    const input = text.trim();
    if (!input) throw new Error('Informe um texto para gerar a fala.');

    const cfg = this.cfg();
    const body: Record<string, string> = {
      input,
      response_format: 'mp3',
    };

    if (cfg.ttsModel.trim()) body.model = cfg.ttsModel.trim();
    if (cfg.voice.trim()) body.voice = cfg.voice.trim();

    const response = await this.fetcher(
      this.endpoint(cfg.base, '/v1/audio/speech'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      },
    );

    if (!response.ok) {
      throw await responseError(response, 'Não foi possível gerar a fala');
    }

    return response.blob();
  }
}

interface RecordingSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  stopping?: Promise<Blob>;
  resolve?: (blob: Blob) => void;
  reject?: (error: Error) => void;
}

export class VoiceRecorder {
  private session: RecordingSession | undefined;
  private starting = false;
  private generation = 0;

  static supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  get recording(): boolean {
    return this.session?.recorder.state === 'recording';
  }

  async start(): Promise<void> {
    if (!VoiceRecorder.supported()) {
      throw new Error('Este navegador não oferece suporte à gravação de voz.');
    }
    if (this.starting || this.session) {
      throw new Error('Já existe uma gravação de voz em andamento.');
    }

    this.starting = true;
    const generation = ++this.generation;
    let stream: MediaStream | undefined;
    let session: RecordingSession | undefined;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // A permissão pode chegar depois que o usuário já cancelou.
      if (generation !== this.generation) {
        throw new Error('A gravação de voz foi cancelada.');
      }

      const mimeType = 'audio/webm;codecs=opus';
      const recorder = MediaRecorder.isTypeSupported(mimeType)
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      session = { recorder, stream, chunks: [] };
      const current = session;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) current.chunks.push(event.data);
      };
      recorder.onstop = () => this.finish(current);
      recorder.onerror = () => {
        this.finish(current, new Error('Não foi possível gravar o áudio.'));
      };

      this.session = session;
      recorder.start();
    } catch {
      if (session) {
        this.finish(session, new Error('Não foi possível iniciar a gravação.'));
      } else {
        stream?.getTracks().forEach((track) => track.stop());
      }

      if (generation !== this.generation) {
        throw new Error('A gravação de voz foi cancelada.');
      }

      throw new Error(
        'Não foi possível iniciar a gravação. Verifique a permissão e o microfone.',
      );
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  stop(): Promise<Blob> {
    const session = this.session;

    if (!session) {
      return Promise.reject(new Error('Não há gravação de voz em andamento.'));
    }
    if (session.stopping) return session.stopping;

    const stopping = new Promise<Blob>((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
    session.stopping = stopping;

    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
      // O evento final continua sendo aguardado, mas o microfone é liberado já.
      session.stream.getTracks().forEach((track) => track.stop());
    } catch {
      this.finish(session, new Error('Não foi possível finalizar a gravação.'));
    }

    return stopping;
  }

  cancel(): void {
    this.generation += 1;
    this.starting = false;

    if (this.session) {
      this.finish(this.session, new Error('A gravação de voz foi cancelada.'));
    }
  }

  private finish(session: RecordingSession, error?: Error): void {
    const recorder = session.recorder;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;

    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      // Mesmo com falha no gravador, todas as faixas precisam ser encerradas.
    } finally {
      session.stream.getTracks().forEach((track) => track.stop());
    }

    if (this.session === session) this.session = undefined;

    if (error) {
      session.reject?.(error);
    } else {
      session.resolve?.(
        new Blob(session.chunks, {
          type: recorder.mimeType || session.chunks[0]?.type || 'audio/webm',
        }),
      );
    }

    session.chunks.length = 0;
    session.resolve = undefined;
    session.reject = undefined;
  }
}

export class VoicePlayer {
  private finishPlayback: ((error?: Error) => void) | undefined;

  play(blob: Blob): Promise<void> {
    this.stop();

    return new Promise<void>((resolve, reject) => {
      let url: string | undefined;
      let audio: HTMLAudioElement | undefined;
      let finished = false;

      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;

        if (audio) {
          audio.onended = null;
          audio.onerror = null;
          audio.pause();
          audio.removeAttribute('src');
        }
        if (url !== undefined) URL.revokeObjectURL(url);
        if (this.finishPlayback === finish) this.finishPlayback = undefined;

        if (error) reject(error);
        else resolve();
      };

      this.finishPlayback = finish;

      try {
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.onended = () => finish();
        audio.onerror = () => {
          finish(new Error('Não foi possível reproduzir a fala.'));
        };

        void audio.play().catch(() => {
          finish(
            new Error(
              'Não foi possível reproduzir a fala. Verifique a permissão de áudio do navegador.',
            ),
          );
        });
      } catch {
        finish(new Error('Não foi possível iniciar a reprodução da fala.'));
      }
    });
  }

  stop(): void {
    // Uma interrupção intencional conclui a reprodução sem gerar erro.
    this.finishPlayback?.();
  }
}
