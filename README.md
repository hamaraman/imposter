# MyCAD

파라메트릭 3D CAD (M2). 클린룸 원칙으로 개발합니다: 공개 문서, 일반 CAD 관례, 직접 관찰한 동작만 근거로 삼습니다.

## 구조
| 경로 | 역할 |
|---|---|
| `packages/core` | 문서 모델, 파라미터·수식, 타임라인, Undo (커널을 모름) |
| `packages/sketch` | 2D 구속조건 솔버 어댑터 (planegcs = FreeCAD 스케처 솔버 WASM) |
| `packages/kernel` | OCCT(replicad) 어댑터. Web Worker에서 실행 |
| `apps/web` | React + Three.js UI |
| `apps/desktop` | Tauri 셸 → Windows `.exe` / `.msi` |
| `tests` | 해석해 기반 오라클 테스트 |

## 실행
```bash
pnpm install
pnpm test            # 오라클 테스트
pnpm dev             # 브라우저에서 http://localhost:5173
pnpm desktop:dev     # 데스크톱 창으로 실행 (Rust 필요)
pnpm desktop:build   # 설치파일 생성 → apps/desktop/src-tauri/target/release/bundle/
```

### Windows에서 EXE를 직접 빌드할 때 필요한 것
1. Node.js 22 이상, pnpm (`npm i -g pnpm`)
2. Rust (https://rustup.rs)
3. Visual Studio Build Tools의 "C++를 사용한 데스크톱 개발" 워크로드

GitHub에 푸시하면 `.github/workflows/windows-exe.yml`이 자동으로 빌드해서 Actions 아티팩트로 올립니다. `v0.1.0` 같은 태그를 푸시하면 Releases에 첨부됩니다.

## M2 기능 (v0.3.0)
- **면 위 스케치**: 새 스케치 ▾ → 면 선택… → 평평한 면 클릭. 면 중심이 스케치 원점 (면 위치는 만들 때 기준으로 고정)
- **회전**: 스케치 X축/Y축 또는 스케치 안의 선(보조선 추천)을 축으로, 각도 지정
- **쉘**: 바디 끝의 평평한 면(+Z 등)을 열고 안쪽으로 두께만 남김. 안 되는 경우 원인을 안내
- **패턴**: 돌출/회전 결과를 직선(방향·간격·개수) 또는 원형(원점 축 둘레)으로 복제
- **미러**: 돌출/회전 결과를 원점 평면(YZ/XZ/XY)에 대칭 복제
- 스케치 **보조선**: 프로필에서 빠지는 선 (회전축 등)

## M1 기능 (v0.2.0)
- **스케치**: XY/XZ/YZ 평면에 선, 사각형, 원, 호 그리기. 기존 점 근처를 클릭하면 자동으로 이어짐
- **구속조건**: 일치, 수평, 수직, 평행, 직교, 동일, 접선, 점→선, 고정
- **치수**: 길이, 거리, 반지름. 값에 파라미터 수식 사용 가능 (`width/2`)
- 상태 표시: 덜 구속(파랑) · 완전 구속(검정) · 충돌(빨강, 충돌한 구속 표시)
- **돌출**: 닫힌 프로필 자동 인식 (안쪽 루프는 구멍), 새 바디 / 결합 / 잘라내기, 음수 거리
- 타임라인: 클릭하면 선택, 더블클릭하면 스케치 편집, 우클릭하면 롤백. 속성 패널에서 억제/삭제

### 스케치 단축키
| 키 | 동작 |
|---|---|
| S / L / R / C / A | 선택 / 선 / 사각형 / 원 / 호 |
| Esc | 그리기 취소, 선택 해제 |
| Delete | 선택한 요소 삭제 |
| 휠 / Alt+드래그 | 확대·축소 / 화면 이동 |

## M0 기능
- 파라미터 표 + 수식 (`width/4` 등)
- 피처: 박스(돌출), 필렛, 관통 구멍
- 타임라인: 클릭하면 억제/해제, 우클릭하면 그 지점까지 롤백
- 실행 취소/다시 실행 (Ctrl+Z / Ctrl+Y)
- 저장/열기 (`.mycad`), STL·STEP 내보내기

## 라이선스 메모
OCCT(replicad-opencascadejs)는 LGPL-2.1입니다. WASM 파일을 별도 파일로 배포하고 수정하지 않으면 앱 본체는 다른 라이선스로 둘 수 있습니다. 배포 전에 고지문(NOTICE)을 추가하세요.
