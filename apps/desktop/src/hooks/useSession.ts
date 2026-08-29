/**
 * useSession — the operator's LOW-FREQUENCY working config as one cohesive slice
 * (active model / role / skills), so the shell isn't a god-component juggling
 * loose useState calls.
 *
 * Deliberately excludes the high-frequency live readouts (cost, context %): those
 * tick many times a second and are owned separately by the shell so they can't
 * churn this config object's identity and re-render every session consumer. Two
 * model setters mirror the two call sites: pickers give a full id+name+provider;
 * the chat stream reports only the resolved name+provider it used.
 */
import { useCallback, useMemo, useState } from "react";

export interface SessionState {
  model: string;
  modelId: string | null;
  provider: string;
  role: string | null;
  skills: string[];
}

export interface UseSessionResult extends SessionState {
  /** Pick a model explicitly (ModelSwitcher / Settings) — carries the id. */
  selectModel: (id: string, name: string, provider: string) => void;
  /** Reflect the model the chat stream actually resolved to (name+provider). */
  reflectModel: (name: string, provider: string) => void;
  setRole: (role: string | null) => void;
  setSkills: (skills: string[]) => void;
}

export function useSession(): UseSessionResult {
  const [model, setModel] = useState("Claude Opus 5");
  const [modelId, setModelId] = useState<string | null>(null);
  const [provider, setProvider] = useState("anthropic");
  const [role, setRole] = useState<string | null>(null);
  const [skills, setSkills] = useState<string[]>([]);

  const selectModel = useCallback((id: string, name: string, prov: string) => {
    setModelId(id);
    setModel(name);
    setProvider(prov);
  }, []);
  const reflectModel = useCallback((name: string, prov: string) => {
    setModel(name);
    setProvider(prov);
  }, []);

  return useMemo(
    () => ({
      model,
      modelId,
      provider,
      role,
      skills,
      selectModel,
      reflectModel,
      setRole,
      setSkills,
    }),
    [model, modelId, provider, role, skills, selectModel, reflectModel],
  );
}
