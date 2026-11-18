"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// The Web Speech API is not in TypeScript's DOM lib. This is the part we use.
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const noop = () => () => {};

/** Speech-to-text into a text field. `onText` receives the full field value: what was there before plus what was heard. */
export function useDictation(onText: (text: string) => void) {
  const supported = useSyncExternalStore(noop, () => Boolean(recognitionCtor()), () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);
  useEffect(() => () => rec.current?.abort(), []);

  const start = (current: string) => {
    const Ctor = recognitionCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language;
    r.continuous = true;
    r.interimResults = true;
    const base = current.trim() ? `${current.trimEnd()} ` : "";
    let heard = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) heard += res[0].transcript;
        else interim += res[0].transcript;
      }
      onTextRef.current((base + heard + interim).replace(/\s+/g, " ").trimStart());
    };
    r.onerror = (e) => {
      if (e.error === "aborted" || e.error === "no-speech") return;
      setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone access is blocked." : "Voice input failed. Try again.");
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    setError(null);
    rec.current = r;
    r.start();
    setListening(true);
  };

  /** Stop and keep what was heard so far. */
  const stop = () => rec.current?.stop();
  /** Stop and drop any result still in flight. */
  const cancel = () => {
    if (!rec.current) return;
    rec.current.onresult = null;
    rec.current.abort();
  };

  return { supported, listening, error, start, stop, cancel };
}
