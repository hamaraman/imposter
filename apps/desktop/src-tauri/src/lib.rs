// 데스크톱 셸: UI와 CAD 로직은 전부 웹 코드(apps/web)에 있고, 여기서는 창과 파일 접근 권한만 담당한다
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("MyCAD 실행 중 오류가 발생했습니다");
}
