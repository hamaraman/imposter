# MyCAD

파라메트릭 3D CAD (M0). 클린룸 원칙으로 개발합니다: 공개 문서, 일반 CAD 관례, 직접 관찰한 동작만 근거로 삼습니다.

## 구조
| 경로 | 역할 |
|---|---|
| `packages/core` | 문서 모델, 파라미터·수식, 타임라인, Undo (커널을 모름) |
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

## M0 기능
- 파라미터 표 + 수식 (`width/4` 등)
- 피처: 박스(돌출), 필렛, 관통 구멍
- 타임라인: 클릭하면 억제/해제, 우클릭하면 그 지점까지 롤백
- 실행 취소/다시 실행 (Ctrl+Z / Ctrl+Y)
- 저장/열기 (`.mycad`), STL·STEP 내보내기

## 라이선스 메모
OCCT(replicad-opencascadejs)는 LGPL-2.1입니다. WASM 파일을 별도 파일로 배포하고 수정하지 않으면 앱 본체는 다른 라이선스로 둘 수 있습니다. 배포 전에 고지문(NOTICE)을 추가하세요.
