import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { BeforeIdPage, CreateRolloutRequest, FirmwareView, RegisterFirmwareRequest, RolloutView, TerminalModelView } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { formatKst } from '../lib/format';

/** 서버 규칙과 같은 버전 형식(api device/heartbeat.service.ts FIRMWARE_VERSION_PATTERN) */
export const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,20}$/;
/** 서버 상한(api firmware.dto.ts MAX_STAGE_TIMEOUT_MS = 하루) */
export const MAX_STAGE_TIMEOUT_MINUTES = 24 * 60;

/**
 * "10, 50, 100" → [10, 50, 100]. 서버 규칙(1~10개, 1~100 정수, 커지는 순서, 마지막 100 — api rollout.service.ts checkStages·CreateRolloutDto)을
 * 미리 본다. 틀리면 이유 글자. 화면 검사는 안내일 뿐 최종 판단은 서버(400 INVALID_STAGES)
 */
export function parseStages(text: string): { stages: number[] } | { error: string } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { error: '단계 비율을 쉼표로 적으세요(예 10, 50, 100).' };
  if (parts.length > 10) return { error: '단계는 10개까지입니다.' };
  if (parts.some((p) => !/^\d+$/.test(p))) return { error: '단계 비율은 1~100 사이 정수입니다.' }; // 0x10·1e1·+10·10.5처럼 Number()가 받아 주는 꼴을 거른다
  const stages = parts.map(Number);
  if (stages.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) return { error: '단계 비율은 1~100 사이 정수입니다.' };
  if (stages.some((p, i) => i > 0 && p <= stages[i - 1])) return { error: '단계 비율은 커지는 순서여야 합니다(누적 비율).' };
  if (stages.at(-1) !== 100) return { error: '마지막 단계는 100이어야 합니다.' };
  return { stages };
}

function useModels(enabled: boolean) {
  return useQuery({ queryKey: keys.terminalModels, queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity, enabled });
}

function ModelSelect({ label, value, onChange, models }: { label: string; value: string; onChange: (v: string) => void; models: TerminalModelView[] | undefined }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">모델 선택</option>
      {models?.map((m) => (
        <option key={m.code} value={m.code}>
          {m.code} {m.name}
        </option>
      ))}
    </select>
  );
}

/** 펌웨어 등록(모델·버전). 같은 (모델, 버전)이 있으면 409 DUPLICATE */
export function FirmwareRegisterForm() {
  const client = useQueryClient();
  const models = useModels(true);
  const [modelCode, setModelCode] = useState('');
  const [version, setVersion] = useState('');
  const versionOk = FIRMWARE_VERSION_PATTERN.test(version);
  const register = useMutation({
    mutationFn: (body: RegisterFirmwareRequest) => api<FirmwareView>('/firmware', { method: 'POST', body }),
    onSuccess: async () => {
      setVersion('');
      await client.invalidateQueries({ queryKey: keys.firmware.all });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (modelCode && versionOk) register.mutate({ modelCode, version } satisfies RegisterFirmwareRequest);
  };
  return (
    <form className="panel" aria-label="펌웨어 등록" onSubmit={submit}>
      <h3>펌웨어 등록</h3>
      <div className="row">
        <ModelSelect label="펌웨어 모델" value={modelCode} onChange={setModelCode} models={models.data} />
        <input aria-label="버전" placeholder="버전(예 2.1.0)" value={version} onChange={(e) => setVersion(e.target.value.trim())} />
        <button type="submit" className="primary" disabled={!modelCode || !versionOk || register.isPending}>
          등록
        </button>
      </div>
      {version && !versionOk ? <p className="field-error">버전은 영문·숫자·점·하이픈 1~20자입니다.</p> : null}
      <ErrorBox error={models.error ?? register.error} />
      {register.data ? (
        <p className="ok" role="status">
          {register.data.modelCode} {register.data.version} 등록됨 · {formatKst(register.data.createdAt)}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 단계 배포 만들기(F8, decisions/0030). 만들자마자 1단계 대상(운영 중 단말기 중 첫 비율만큼)에 제안이 나가므로 확인을 받는다.
 * 버전은 그 모델에 등록된 펌웨어에서 고른다(GET /firmware?modelCode=, decisions/0066). 같은 모델에 진행 중·멈춤 배포가 있으면 409 ROLLOUT_ALREADY_ACTIVE
 */
export function RolloutCreateForm() {
  const client = useQueryClient();
  const models = useModels(true);
  const [modelCode, setModelCode] = useState('');
  const [version, setVersion] = useState('');
  const [stagesText, setStagesText] = useState('10, 50, 100');
  const [thresholdPct, setThresholdPct] = useState('20');
  const [minSamples, setMinSamples] = useState('5');
  const [timeoutMin, setTimeoutMin] = useState('10');

  const firmware = useQuery({
    queryKey: keys.firmware.byModel(modelCode),
    queryFn: () => api<BeforeIdPage<FirmwareView>>('/firmware', { query: { modelCode, limit: 100 } }),
    enabled: modelCode !== '',
  });

  const parsed = parseStages(stagesText);
  const threshold = Number(thresholdPct);
  const samples = Number(minSamples);
  const minutes = Number(timeoutMin);
  const problems = [
    'error' in parsed ? parsed.error : null,
    thresholdPct === '' || !(threshold >= 0 && threshold <= 100) ? '실패 임계치는 0~100%입니다.' : null,
    !Number.isInteger(samples) || samples < 1 ? '최소 표본은 1 이상 정수입니다.' : null,
    !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_STAGE_TIMEOUT_MINUTES ? `단계 시간 제한은 1~${MAX_STAGE_TIMEOUT_MINUTES}분 정수입니다.` : null,
  ].filter((p): p is string => p !== null);

  const create = useMutation({
    mutationFn: (body: CreateRolloutRequest) => api<RolloutView>('/firmware-rollouts', { method: 'POST', body }),
    // 실패(409 ROLLOUT_ALREADY_ACTIVE 등)도 목록이 낡았다는 뜻일 수 있어 성공·실패 모두 다시 읽는다
    onSuccess: () => setVersion(''), // 같은 버전으로 또 눌러 409를 받지 않게(성공 문구는 남는다)
    onSettled: () => client.invalidateQueries({ queryKey: keys.rollouts.all }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!modelCode || !version || problems.length > 0 || 'error' in parsed) return;
    const body = {
      modelCode,
      version,
      stages: parsed.stages,
      failureThreshold: threshold / 100,
      minSamples: samples,
      stageTimeoutMs: minutes * 60_000,
    } satisfies CreateRolloutRequest;
    if (!window.confirm(`${modelCode} ${version} 배포를 시작할까요? 1단계(${parsed.stages[0]}%) 대상 단말기에 바로 업데이트 제안이 나갑니다.`)) return;
    create.mutate(body);
  };

  const versions = firmware.data?.items ?? [];
  return (
    <form className="panel" aria-label="배포 만들기" onSubmit={submit}>
      <h3>배포 만들기</h3>
      <div className="row">
        <ModelSelect
          label="배포 모델"
          value={modelCode}
          onChange={(v) => {
            setModelCode(v);
            setVersion('');
          }}
          models={models.data}
        />
        <select aria-label="배포 버전" value={version} disabled={!modelCode || versions.length === 0} onChange={(e) => setVersion(e.target.value)}>
          <option value="">버전 선택</option>
          {versions.map((f) => (
            <option key={f.id} value={f.version}>
              {f.version}
            </option>
          ))}
        </select>
      </div>
      {modelCode && firmware.data && versions.length === 0 ? <p className="hint">이 모델에 등록된 펌웨어가 없습니다. 먼저 펌웨어를 등록하세요.</p> : null}
      <div className="row">
        <label>
          단계 비율(%) <input aria-label="단계 비율" value={stagesText} onChange={(e) => setStagesText(e.target.value)} />
        </label>
        <label>
          실패 임계치(%) <input aria-label="실패 임계치" type="number" min={0} max={100} value={thresholdPct} onChange={(e) => setThresholdPct(e.target.value)} />
        </label>
        <label>
          최소 표본 <input aria-label="최소 표본" type="number" min={1} value={minSamples} onChange={(e) => setMinSamples(e.target.value)} />
        </label>
        <label>
          단계 시간 제한(분) <input aria-label="단계 시간 제한" type="number" min={1} max={MAX_STAGE_TIMEOUT_MINUTES} value={timeoutMin} onChange={(e) => setTimeoutMin(e.target.value)} />
        </label>
      </div>
      {problems.map((p) => (
        <p key={p} className="field-error">
          {p}
        </p>
      ))}
      <p className="hint">단계마다 보고가 최소 표본 이상 모이면 실패율을 보고, 임계치를 넘으면 자동 중단합니다. 시간 제한 안에 보고하지 않은 단말기는 시간 초과로 셉니다.</p>
      <button type="submit" className="primary" disabled={!modelCode || !version || problems.length > 0 || create.isPending}>
        배포 시작
      </button>
      <ErrorBox error={models.error ?? firmware.error ?? create.error} />
      {create.data ? (
        <p className="ok" role="status">
          배포 #{create.data.id} {create.data.modelCode} {create.data.version} 시작 · 1단계 대상 {create.data.stageStats[0]?.targets ?? 0}대
        </p>
      ) : null}
    </form>
  );
}
