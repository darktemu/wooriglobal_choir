# 찬양대 연습노트 (PWA)

여러 성가대가 함께 쓰는 성가대 연습 앱입니다. 예배별 선곡, 파트별 연습 음원·영상, 곡 분석을 성가대마다 따로 관리합니다.
빌드 과정 없는 정적 웹앱이라 Vercel에 그대로 올리면 되고, 휴대폰에서 "홈 화면에 추가"하면 앱처럼 열립니다.

- **로그인 필수**: 가입·로그인해야 볼 수 있습니다.
- **자동 승인**: 가입하면 바로 쓸 수 있고, 성가대를 고르면 바로 가입됩니다.
- **여러 성가대**: 목록에서 고르거나 새로 만들고, ‘설정’에서 언제든 다른 성가대로 바꿉니다.
- **역할**
  | 역할 | 할 수 있는 일 |
  |---|---|
  | 관리자 | 성가대를 만든 사람. 선곡·곡·공지 편집, 대원 역할 변경·내보내기 |
  | 편집자 | 선곡·곡·공지 편집 |
  | 대원 | 보기, 내 파트 설정, 연습 완료 체크 |
- **연습 도구**: https 음원 앱 안 재생(속도 조절, A-B 구간 반복), 유튜브 재생, 메트로놈, 첫음 듣기
- **오프라인**: 마지막으로 받은 선곡을 인터넷 없이도 보여줍니다.

## 폴더 구성

```
index.html             앱 화면 틀
styles.css             디자인
app.js                 앱 동작 (로그인, 성가대, Supabase 연동)
config.js              Supabase 주소와 키 ← 여기만 고치면 됩니다
manifest.webmanifest   홈 화면 설치 정보 (이름, 아이콘, 색)
sw.js                  서비스 워커 (오프라인, 캐시)
vercel.json            Vercel 헤더 설정
icons/                 앱 아이콘
supabase/schema.sql    DB 테이블, 권한, 가입·성가대 기능
```

---

## 1단계. Supabase 준비 (데이터 저장소, 무료)

1. https://supabase.com 에서 **New project**를 만듭니다. 지역은 `Northeast Asia (Seoul)`.
2. 왼쪽 메뉴 **SQL Editor** → `supabase/schema.sql` 전체를 붙여 넣고 **Run**.
   - 예전 버전(성가대 1개)을 쓰던 프로젝트라면 그대로 실행하세요. 기존 곡·선곡은 첫 번째 성가대로 옮겨지고, 예전 `editors`에 있던 계정은 그 성가대의 관리자가 됩니다.
3. **Authentication → Sign In / Providers → Email** 에서
   - **Allow new users to sign up**: 켜기 (대원이 직접 가입)
   - **Confirm email**: 끄기 (자동 승인 — 가입 즉시 로그인)
4. **Authentication → URL Configuration** 에서
   - **Site URL**: Vercel 배포 주소 (예: `https://choir-practice.vercel.app`)
   - **Redirect URLs**: 같은 주소를 추가 (비밀번호 재설정 메일 링크용)
5. **Project Settings → API** 에서 `Project URL`과 `anon public` 키를 복사해 `config.js`에 넣습니다.
   ```js
   window.CHOIR_CONFIG = {
     supabaseUrl: "https://abcdxyz.supabase.co",
     supabaseAnonKey: "eyJhbGciOi..."
   };
   ```
   anon 키는 공개되어도 괜찮습니다. 누가 무엇을 볼 수 있고 쓸 수 있는지는 `schema.sql`의 보안 규칙이 정합니다.
   **service_role 키는 절대 넣지 마세요.**

## 2단계. Vercel에 배포

### 방법 A. GitHub 연결 (추천)

1. GitHub 저장소에 이 폴더 내용을 올립니다. (이미 올려 두었다면 파일을 바꾸고 push)
   ```bash
   cd choirnote-pwa
   git add . && git commit -m "여러 성가대, 로그인 필수" && git push
   ```
   처음이라면:
   ```bash
   git init && git add . && git commit -m "찬양대 연습노트"
   git branch -M main
   git remote add origin https://github.com/<아이디>/choir-practice.git
   git push -u origin main
   ```
2. https://vercel.com → **Add New… → Project** → 저장소 **Import**.
   Framework Preset은 **Other**, Build Command와 Output Directory는 비워 둡니다.
3. **Deploy**. 이후에는 `git push`만 하면 자동으로 다시 배포됩니다.

### 방법 B. 명령어로

```bash
cd choirnote-pwa
npx vercel --prod
```

## 3단계. 처음 쓰는 순서

1. 지휘자가 앱을 열고 **가입하기** → 이름·파트·이메일·비밀번호 입력.
2. 성가대 선택 화면에서 **새 성가대 만들기** (예: `은평교회 할렐루야 찬양대`). 만든 사람이 관리자가 됩니다.
3. 상단 **편집**에서 곡을 추가하고 예배 날짜에 선곡합니다.
4. 대원들에게 주소를 공유합니다. 대원은 가입 후 목록에서 우리 성가대를 눌러 바로 가입합니다.
5. 함께 편집할 임원은 관리자가 **설정 → 대원**에서 역할을 ‘편집자’로 바꿔 줍니다.

## 대원들에게 설치 안내

- **안드로이드 (크롬)**: 주소를 열면 화면 위에 ‘설치’ 버튼이 보입니다. 안 보이면 크롬 메뉴(⋮) → **앱 설치**.
- **아이폰 (Safari)**: Safari로 열고 아래쪽 **공유 버튼(□↑) → 홈 화면에 추가**. 카카오톡 안에서는 설치가 안 되니 ‘Safari로 열기’를 먼저 누르세요.

## 문제가 생겼을 때

앱 상단의 ‘연결 오류’ 안내나 아래쪽 메시지에 원인이 나옵니다.

| 메시지 | 해결 |
|---|---|
| 데이터베이스 권한(GRANT)이 없습니다 / 설정이 최신이 아닙니다 | `schema.sql` 전체를 SQL Editor에서 다시 실행 (여러 번 실행해도 안전) |
| 이메일 확인이 켜져 있어요 / 가입 확인 메일을 보냈어요 | Supabase에서 **Confirm email** 끄기 |
| 가입이 꺼져 있어요 | Supabase에서 **Allow new users to sign up** 켜기 |
| 편집 권한이 없어 저장되지 않았어요 | 관리자에게 편집자 지정 요청 |
| 마지막 관리자는 탈퇴할 수 없어요 | 다른 대원을 관리자로 지정한 뒤 탈퇴 |

- **비밀번호를 잊은 대원**: 로그인 화면의 ‘비밀번호를 잊었어요’로 재설정 메일을 받습니다. Supabase 기본 메일은 시간당 보낼 수 있는 수가 적어서, 안 오면 관리자가 Supabase **Authentication → Users**에서 직접 비밀번호를 바꿔 줄 수 있습니다.
- **성가대 삭제**: 앱에서는 지우지 않습니다. 필요하면 Supabase **Table Editor → choirs**에서 지우면 곡·선곡·대원 기록이 함께 지워집니다.

## 알아두기

- 성가대 목록에는 이름과 대원 수만 보입니다. 곡·선곡·공지·대원 명단은 그 성가대에 가입한 사람만 볼 수 있습니다.
- 자동 승인이라 가입한 누구나 목록의 성가대에 들어갈 수 있습니다. 나중에 가입 코드나 승인 절차가 필요하면 추가할 수 있습니다.
- 연습 완료 체크는 기기마다 따로 저장됩니다.
- 업데이트가 안 보이면 앱을 완전히 닫았다 다시 여세요. 기능을 크게 바꿨다면 `sw.js` 맨 위 `VERSION`을 올려 배포하세요.
- 파트 연습 음원·영상·악보의 저작권은 각 출판사에 있습니다. 공식 연습실이나 공개 영상의 링크만 넣고 파일을 직접 올리지 마세요.

## 나중에 스토어 앱으로

- **Play 스토어**: https://www.pwabuilder.com 에 배포 주소를 넣고 Android 패키지를 받습니다. (개발자 등록 25달러, 1회)
- **App Store**: Capacitor로 감싸 Xcode에서 빌드합니다. (Mac 필요, 연 99달러, 심사 반려 가능성 있음)
