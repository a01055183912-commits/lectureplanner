# 강의 계획서 설계기

주제·대상·형태(강의/실습/시연/토의/기타 %)·시간을 입력하면 Claude가 강의 계획서를 생성합니다.
목표·특장점·기대 효과·수강 요건·필요 사항·세부 타임라인·상세 커리큘럼을 출력하며,
인라인 편집, 섹션/세션별 AI 재생성, PDF 인쇄, MD 저장을 지원합니다.
고용24 국민내일배움카드 훈련과정을 조회해 **유사 교육 참고** 또는 **기존 과정에 없는 내용 제안** 모드로 설계할 수 있습니다.

## 환경변수
| 이름 | 필수 | 설명 |
|---|---|---|
| `CLAUDE_API_KEY` | 필수 | Claude API 키 |
| `KOREA_EDU_INFO` | 선택 | 고용24 OPEN-API 인증키(authKey). 없으면 내배카 조회 없이 동작 |
| `ACCESS_CODE` | 선택 | 설정 시 API 호출에 접근 코드 필요 (공개 배포 시 비용 보호 권장) |
| `CLAUDE_MODEL` | 선택 | 기본 `claude-opus-5-5` |

## 로컬 실행
```bash
npm install
export CLAUDE_API_KEY=... KOREA_EDU_INFO=...
npm start
```

## Railway 배포
1. Railway에서 *New Project → Deploy from GitHub repo*로 저장소 연결
2. *Variables*에 위 환경변수 입력 (`PORT`는 Railway가 자동 주입)
3. *Settings → Networking → Generate Domain*

API 키는 서버에서만 사용되며 브라우저에 노출되지 않습니다.
