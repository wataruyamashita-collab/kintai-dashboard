const APP_CONFIG = {
  APP_NAME: '勤怠アラートHTML',
  TIMEZONE: 'Asia/Tokyo',
  DRIVE_FOLDER_NAME: '勤怠アラートHTML_保存データ',
  LATEST_FILE_NAME: 'latest_alert_snapshot.json',
  AUTH_FILE_NAME: 'auth_rules.json',
  EMPLOYEE_MASTER_FILE_NAME: 'employee_master.json',
  COMPANY_CALENDAR_PREFIX: 'company_calendar_'
};

// 本番用の初期権限は、権限管理テーブルまたは auth_rules.json で設定してください。
// 実メールアドレスをコードに固定しないため、デフォルトは空にしています。
const DEFAULT_AUTH_RULES = [];

const DEFAULT_EMPLOYEE_MASTER = {};

const DEPARTMENT_GROUP_ALL = '全社';
const DEPARTMENT_GROUP_UNCLASSIFIED = '未分類';

const DEPARTMENT_GROUP_RULES = [
  {
    group: '営業支援ユニット',
    keywords: [
      '営業支援ユニット',
      'クラウド推進課',
      'ｸﾗｳﾄﾞ推進課',
      'カスタマーサクセス推進課',
      'ｶｽﾀﾏｰｻｸｾｽ推進課',
      '業務支援課'
    ]
  },
  {
    group: '管理課',
    keywords: ['管理課']
  },
  {
    group: '営業ユニット',
    keywords: [
      '営業ユニット',
      '営業所',
      '出張所',
      '東日本エリア',
      '関東エリア',
      '中部エリア',
      '西日本エリア',
      '北陸',
      '長野',
      '埼玉',
      '東京',
      '札幌',
      '仙台',
      '名古屋',
      '大阪',
      '広島',
      '福岡',
      '新潟',
      '茨城',
      '静岡'
    ]
  }
];

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_CONFIG.APP_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * 初期表示データを取得する。
 * 保存済みスナップショットに手入力内容を復元し、ログインユーザーの権限で表示範囲を絞り込む。
 */
function getInitialData() {
  const user = getCurrentUser_();
  const snapshot = loadJsonFile_(APP_CONFIG.LATEST_FILE_NAME);
  const availableMonths = listAvailableSnapshotMonths_();

  if (!snapshot) {
    const departmentGroups = createDepartmentGroupOptions_();
    const departmentGroupStatus = createDepartmentGroupStatus_([]);

    return {
      user,
      hasSnapshot: false,
      snapshotMeta: null,
      rows: [],
      summary: createSummary_([]),
      departments: [],
      clientConfig: getClientConfigForUser_(user, { departmentGroups, departmentGroupStatus }),
      permissions: createClientPermissions_(user),
      departmentGroups,
      departmentGroupStatus,
      availableMonths
    };
  }

  return createSnapshotResponse_(user, snapshot, availableMonths);
}


/**
 * 指定月の保存済みスナップショットを取得する。
 * month は yyyy/MM または yyyy-MM を受け付ける。
 */
function getSnapshotByMonth(month) {
  const user = getCurrentUser_();
  const targetMonth = normalizeTargetMonth_(month);
  if (!targetMonth) throw new Error('対象月の形式が不正です。');

  const snapshot = loadSnapshotByMonth_(targetMonth);
  if (!snapshot) {
    throw new Error(`${targetMonth.replace('/', '年')}月の保存済みデータがありません。`);
  }

  return createSnapshotResponse_(user, snapshot, listAvailableSnapshotMonths_());
}


function createSnapshotResponse_(user, snapshot, availableMonths) {
  const targetMonth = snapshot.meta && snapshot.meta.targetMonth
    ? snapshot.meta.targetMonth
    : '';

  const sourceRows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const authorityRows = filterRowsByAuthority_(sourceRows, user);
  const displayRows = filterRowsByDisplayMode_(authorityRows, snapshot.meta && snapshot.meta.displayMode);
  const rows = mergeManualInputsToRows_(displayRows, targetMonth);
  const isAdmin = user && user.role === 'admin';
  const departmentGroups = isAdmin
    ? createDepartmentGroupOptions_(sourceRows)
    : createVisibleDepartmentGroupOptions_(user);
  const departmentGroupStatus = isAdmin
    ? createDepartmentGroupStatus_(sourceRows)
    : createDepartmentGroupStatusFromRows_(rows);

  return {
    user,
    hasSnapshot: true,
    snapshotMeta: snapshot.meta,
    rows,
    summary: createSummary_(rows),
    departments: createDepartmentList_(rows),
    clientConfig: getClientConfigForUser_(user, { departmentGroups, departmentGroupStatus, sourceRows }),
    permissions: createClientPermissions_(user),
    departmentGroups,
    departmentGroupStatus,
    availableMonths: availableMonths || listAvailableSnapshotMonths_()
  };
}

/**
 * 表示中の集計結果だけを保存する。
 * ファイル再取込、HTML解析、月別再集計は行わない。
 */
function saveClientSnapshot(payload) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  if (!payload || !payload.targetMonth || !payload.cutoffDate || !Array.isArray(payload.rows)) {
    throw new Error('保存データの形式が不正です。');
  }

  const targetMonth = normalizeTargetMonth_(payload.targetMonth);
  const cutoffDate = normalizeDateKey_(payload.cutoffDate);

  if (!targetMonth) throw new Error('対象月の形式が不正です。');
  if (!cutoffDate) throw new Error('集計基準日の形式が不正です。');

  const validationMetrics = validateClientSnapshotPayload_(payload, targetMonth, cutoffDate);

  const snapshot = {
    meta: {
      targetMonth,
      cutoffDate,
      uploadedAt: Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss'),
      uploadedBy: user.email,
      originalFileName: String(payload.originalFileName || ''),
      sourceRows: Number(payload.sourceRows || 0),
      analyzedEmployees: payload.rows.length,
      appVersion: '2.9-csv-finalize-auto-analyze',
      displayMode: String(payload.displayMode || 'alertsOnly'),
      usePastAverage: Boolean(payload.usePastAverage),
      businessDays: payload.businessDays || null,
      businessDaySource: payload.businessDaySource || null,
      holidays: payload.holidays || [],
      calculationAudit: payload.calculationAudit || null,
      validationMetrics,
      over45Definition: '45h超過回数は、対象年1月以降、36協定45h判定対象の残業時間が45時間を超えた月数です。',
      forecastDefinition: '月末残業予測は、45h（法定時間外労働）、60h（月60時間超割増対象・法定休日労働を除く）、80h（時間外＋休日労働）を別々の実績値で、現時点実績 + (現時点実績 ÷ 実績経過日数（出社日数＋集計基準日までの年次有休取得日数）) × 未来の稼働見込み日数（残営業日数－集計基準日後の年次有休予定日数）により算出します。見込みは小数第1位切り上げ、超過判定は > で行います。',
      approvalDefinition: '本画面は管理職向けの早期警戒情報を作成する管理用画面です。36協定上の確定判定および給与処理には使用しません。CSV取込は10MB未満のファイルを対象に、引用符内のカンマ・改行を考慮して必要列のみを抽出します。集計基準日は取込データから自動判定し、開始時刻・終了時刻のみでは実績日と判定しません。特別条項の発動事由、健康福祉措置、備考はモーダルで入力・削除できます。36協定適用事前申請はプルダウンで選択できます。'
    },
    rows: payload.rows
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    saveSnapshot_(snapshot);
  } finally {
    lock.releaseLock();
  }

  const authorityRows = filterRowsByAuthority_(snapshot.rows, user);
  const filteredRows = filterRowsByDisplayMode_(authorityRows, snapshot.meta.displayMode);

  return {
    user,
    hasSnapshot: true,
    snapshotMeta: snapshot.meta,
    rows: filteredRows,
    summary: createSummary_(filteredRows),
    departments: createDepartmentList_(filteredRows),
    clientConfig: getClientConfigForUser_(user),
    permissions: createClientPermissions_(user),
    departmentGroups: createDepartmentGroupOptions_(snapshot.rows),
    departmentGroupStatus: createDepartmentGroupStatus_(snapshot.rows),
    availableMonths: listAvailableSnapshotMonths_()
  };
}


function validateClientSnapshotPayload_(payload, targetMonth, cutoffDate) {
  const rows = payload.rows;
  if (rows.length === 0) {
    throw new Error('保存対象の集計結果が0件です。');
  }
  if (rows.length > 10000) {
    throw new Error('保存対象の集計結果が多すぎます。条件を絞り込んでください。');
  }

  const sourceRows = Number(payload.sourceRows || 0);
  if (!Number.isFinite(sourceRows) || sourceRows < 0) {
    throw new Error('元データ行数が不正です。');
  }

  const businessDays = payload.businessDays === null || payload.businessDays === undefined || payload.businessDays === ''
    ? null
    : Number(payload.businessDays);
  if (businessDays !== null && (!Number.isFinite(businessDays) || businessDays <= 0 || businessDays > 31)) {
    throw new Error('営業日数が不正です。');
  }

  const metrics = createSnapshotValidationMetrics_(rows);
  const clientMetrics = payload.validationMetrics;
  if (!clientMetrics || typeof clientMetrics !== 'object') {
    throw new Error('保存前検証情報が不足しています。画面を再読み込みしてから再集計してください。');
  }

  compareMetric_(clientMetrics, metrics, 'rowCount', '表示人数');
  compareMetric_(clientMetrics, metrics, 'highCount', '高リスク人数');
  compareMetric_(clientMetrics, metrics, 'mediumHighCount', '中高リスク人数');
  compareMetric_(clientMetrics, metrics, 'mediumCount', '中リスク人数');
  compareMetric_(clientMetrics, metrics, 'lowCount', 'リスクなし人数');
  compareMetric_(clientMetrics, metrics, 'missingCount', '未入力あり人数');
  compareMetric_(clientMetrics, metrics, 'estimatedOtTotal', '概算残業時間合計');
  compareMetric_(clientMetrics, metrics, 'fixedOtTotal', '確定残業時間合計');
  compareMetric_(clientMetrics, metrics, 'forecastTotal', '月末残業予測時間合計');
  compareMetric_(clientMetrics, metrics, 'over45Total', '45h超過回数合計');

  if (payload.calculationAudit && typeof payload.calculationAudit === 'object') {
    const checkedRows = Number(payload.calculationAudit.checkedRows);
    if (!Number.isFinite(checkedRows) || checkedRows !== rows.length) {
      throw new Error('検算済み件数と保存対象件数が一致しません。再集計してから保存してください。');
    }
  }

  return Object.assign({}, metrics, {
    targetMonth,
    cutoffDate,
    sourceRows,
    businessDays,
    validatedAt: Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss')
  });
}

function createSnapshotValidationMetrics_(rows) {
  const riskCounts = { high: 0, mediumHigh: 0, medium: 0, low: 0 };
  const errors = [];
  const totals = rows.reduce((acc, row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${index + 1}行目の形式が不正です。`);
      return acc;
    }

    const label = `${row.employeeName || '氏名不明'}（${row.employeeCode || 'コードなし'}）`;
    if (!String(row.employeeCode || '').trim() && !String(row.employeeName || '').trim()) {
      errors.push(`${index + 1}行目の社員コードまたは社員名を特定できません。`);
    }

    const riskLevel = String(row.riskLevel || 'low');
    if (!Object.prototype.hasOwnProperty.call(riskCounts, riskLevel)) {
      errors.push(`${label} のリスク区分が不正です。`);
    } else {
      riskCounts[riskLevel] += 1;
    }

    const estimatedOt = readSnapshotNumber_(row.estimatedOt, `${label} 概算残業時間`, errors);
    const fixedOt = readSnapshotNumber_(row.fixedOt, `${label} 確定残業時間`, errors);
    const forecast = readSnapshotNumber_(row.monthEndForecastValue, `${label} 月末残業予測時間`, errors);
    const over45 = readSnapshotNumber_(row.over45Count, `${label} 45h超過回数`, errors);

    if (estimatedOt < 0) errors.push(`${label} 概算残業時間がマイナスです。`);
    if (fixedOt < 0) errors.push(`${label} 確定残業時間がマイナスです。`);
    if (forecast < 0) errors.push(`${label} 月末残業予測時間がマイナスです。`);
    if (over45 < 0) errors.push(`${label} 45h超過回数がマイナスです。`);

    const expectedMissing = calculateMissingItemsServer_(row).slice().sort().join('|');
    const actualMissing = (Array.isArray(row.missingItems) ? row.missingItems : []).slice().sort().join('|');
    if (expectedMissing !== actualMissing) {
      errors.push(`${label} の未入力判定が集計結果と一致しません。`);
    }

    acc.estimatedOtTotal += estimatedOt;
    acc.fixedOtTotal += fixedOt;
    acc.forecastTotal += forecast;
    acc.over45Total += over45;
    if (Array.isArray(row.missingItems) && row.missingItems.length > 0) acc.missingCount += 1;
    return acc;
  }, {
    estimatedOtTotal: 0,
    fixedOtTotal: 0,
    forecastTotal: 0,
    over45Total: 0,
    missingCount: 0
  });

  if (errors.length > 0) {
    throw new Error('保存前検証エラー：' + errors.slice(0, 8).join(' / ') + (errors.length > 8 ? ` ほか${errors.length - 8}件` : ''));
  }

  return {
    rowCount: rows.length,
    highCount: riskCounts.high,
    mediumHighCount: riskCounts.mediumHigh,
    mediumCount: riskCounts.medium,
    lowCount: riskCounts.low,
    missingCount: totals.missingCount,
    estimatedOtTotal: roundSnapshotMetric_(totals.estimatedOtTotal),
    fixedOtTotal: roundSnapshotMetric_(totals.fixedOtTotal),
    forecastTotal: roundSnapshotMetric_(totals.forecastTotal),
    over45Total: roundSnapshotMetric_(totals.over45Total)
  };
}

function readSnapshotNumber_(value, label, errors) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    errors.push(`${label} が数値ではありません。`);
    return 0;
  }
  return num;
}

function compareMetric_(clientMetrics, serverMetrics, key, label) {
  const clientValue = Number(clientMetrics[key]);
  const serverValue = Number(serverMetrics[key]);
  if (!Number.isFinite(clientValue) || Math.abs(clientValue - serverValue) > 0.02) {
    throw new Error(`${label}の検証に失敗しました。画面を再読み込みしてから再集計してください。`);
  }
}

function roundSnapshotMetric_(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getClientConfigForUser_(user, precomputed) {
  if (!user || user.role !== 'admin') {
    return null;
  }

  const options = precomputed || {};
  const departmentGroups = Array.isArray(options.departmentGroups)
    ? options.departmentGroups
    : createDepartmentGroupOptions_(options.sourceRows);
  const departmentGroupStatus = options.departmentGroupStatus
    || createDepartmentGroupStatus_(options.sourceRows);

  return {
    departmentGroupRules: DEPARTMENT_GROUP_RULES,
    departmentGroups,
    departmentGroupStatus,
    departmentGroupMaster: createDepartmentGroupMaster_(),
    employeeMaster: loadEmployeeMaster_()
  };
}

function filterRowsByAuthority_(rows, user) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!user) return [];
  if (user.role === 'admin') return sourceRows;

  const userDepartment = String(user.department || '');
  return sourceRows.filter(row => String(row.departmentGroup || '') === userDepartment);
}

function filterRowsByDisplayMode_(rows, displayMode) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (String(displayMode || 'alertsOnly') === 'allEmployees') return sourceRows;
  return sourceRows.filter(row => row && (row.actualAlert || row.forecastAlert));
}

function createVisibleDepartmentGroupOptions_(user) {
  const department = String(user && user.department || '').trim();
  return department ? [department] : [];
}

function createSummary_(rows) {
  return {
    total: rows.length,
    high: rows.filter(r => r.riskLevel === 'high').length,
    mediumHigh: rows.filter(r => r.riskLevel === 'mediumHigh').length,
    medium: rows.filter(r => r.riskLevel === 'medium').length,
    low: rows.filter(r => r.riskLevel === 'low').length,
    missing: rows.filter(r => r.missingItems && r.missingItems.length > 0).length
  };
}

function createDepartmentList_(rows) {
  return [...new Set(rows.map(r => r.department).filter(Boolean))].sort();
}


function createDepartmentGroupOptions_(extraRows) {
  const groups = new Set([DEPARTMENT_GROUP_ALL]);
  const hasExtraRows = Array.isArray(extraRows) && extraRows.length > 0;

  collectDepartmentGroupsFromRows_(groups, hasExtraRows ? extraRows : []);

  if (!hasExtraRows) {
    const snapshot = loadJsonFile_(APP_CONFIG.LATEST_FILE_NAME);
    if (snapshot && Array.isArray(snapshot.rows)) {
      collectDepartmentGroupsFromRows_(groups, snapshot.rows);
    }
  }

  loadManualInputsAll_().forEach(record => addDepartmentGroupOption_(groups, record.departmentGroup));
  loadAuthDepartments_().forEach(department => addDepartmentGroupOption_(groups, department));

  const employeeMaster = loadEmployeeMaster_();
  Object.keys(employeeMaster || {}).forEach(key => {
    addDepartmentGroupOption_(groups, employeeMaster[key] && employeeMaster[key].departmentGroup);
  });

  DEPARTMENT_GROUP_RULES.forEach(rule => addDepartmentGroupOption_(groups, rule.group));

  return [DEPARTMENT_GROUP_ALL].concat(
    [...groups]
      .filter(group => group && group !== DEPARTMENT_GROUP_ALL && group !== DEPARTMENT_GROUP_UNCLASSIFIED)
      .sort()
  );
}

function createDepartmentGroupStatus_(rows) {
  const sourceRows = Array.isArray(rows) && rows.length > 0
    ? rows
    : ((loadJsonFile_(APP_CONFIG.LATEST_FILE_NAME) || {}).rows || []);
  return createDepartmentGroupStatusFromRows_(sourceRows);
}

function createDepartmentGroupStatusFromRows_(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const unclassifiedRows = sourceRows.filter(row => String(row.departmentGroup || '') === DEPARTMENT_GROUP_UNCLASSIFIED);
  const departments = [...new Set(unclassifiedRows.map(row => String(row.department || '').trim()).filter(Boolean))].sort();

  return {
    unclassifiedCount: unclassifiedRows.length,
    unclassifiedDepartments: departments
  };
}

function collectDepartmentGroupsFromRows_(groups, rows) {
  (Array.isArray(rows) ? rows : []).forEach(row => addDepartmentGroupOption_(groups, row && row.departmentGroup));
}

function addDepartmentGroupOption_(groups, value) {
  const group = String(value || '').trim();
  if (group) groups.add(group);
}

function loadManualInputsAll_() {
  const ss = getManualManagementSpreadsheetIfExists_();
  if (!ss) return [];
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.MANUAL_CURRENT_SHEET);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  return readSheetObjects_(sheet)
    .filter(row => String(row.deleted || '').toUpperCase() !== 'TRUE');
}

function loadAuthDepartments_() {
  const ss = getManualManagementSpreadsheetIfExists_();
  if (!ss) return [];
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  return readSheetObjects_(sheet)
    .filter(row => String(row.enabled || '').toUpperCase() !== 'FALSE')
    .map(row => String(row.department || '').trim())
    .filter(Boolean);
}


function createDepartmentGroupMaster_() {
  const master = {};
  const snapshot = loadJsonFile_(APP_CONFIG.LATEST_FILE_NAME);
  if (snapshot && Array.isArray(snapshot.rows)) {
    addDepartmentGroupMasterRows_(master, snapshot.rows);
  }

  addDepartmentGroupMasterRows_(master, loadManualInputsAll_());

  const employeeMaster = loadEmployeeMaster_();
  Object.keys(employeeMaster || {}).forEach(key => {
    const item = employeeMaster[key] || {};
    addDepartmentGroupMasterEntry_(master, item.department, item.departmentGroup);
  });

  return master;
}

function addDepartmentGroupMasterRows_(master, rows) {
  (Array.isArray(rows) ? rows : []).forEach(row => {
    addDepartmentGroupMasterEntry_(master, row && row.department, row && row.departmentGroup);
  });
}

function addDepartmentGroupMasterEntry_(master, department, departmentGroup) {
  const dept = String(department || '').trim();
  const group = String(departmentGroup || '').trim();
  if (!dept || !group || group === DEPARTMENT_GROUP_UNCLASSIFIED) return;
  if (!master[dept]) master[dept] = group;
}

function getCurrentUser_() {
  const email = Session.getActiveUser().getEmail();

  if (!email) {
    throw new Error('ログインユーザーのメールアドレスを取得できません。Webアプリの公開範囲と実行設定を確認してください。');
  }

  const authRules = loadAuthRules_();
  const normalizedEmail = String(email).trim().toLowerCase();
  let rule = authRules.find(r => String(r.email).trim().toLowerCase() === normalizedEmail);

  if (!rule && authRules.length === 0) {
    rule = bootstrapInitialAdminRule_(normalizedEmail);
  }

  if (!rule) {
    throw new Error(`アクセス権限がありません：${email}`);
  }

  const role = normalizeAuthRole_(rule.role);
  const department = String(rule.department || '').trim();

  if (!role || !department) {
    throw new Error(`アクセス権限がありません：${email}`);
  }

  return {
    email,
    department,
    role
  };
}

function normalizeAuthRole_(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'admin') return 'admin';
  if (normalized === 'manager') return 'manager';
  if (normalized === 'viewer' || normalized === 'executive') return 'viewer';
  return '';
}

/**
 * 権限が一切未設定の初回起動時だけ、現在のログインユーザーを管理者として登録する。
 * 実メールアドレスをソースコードへ固定せず、以後は権限管理テーブルで管理するための救済処理。
 */
function bootstrapInitialAdminRule_(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || hasAnyAuthConfiguration_()) return null;

  setupManagementBaseTables();

  const ss = getOrCreateManualInputSpreadsheet_();
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  const historySheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_HISTORY_SHEET);
  if (!sheet) return null;

  const now = getNowText_();
  const record = {
    email: normalizedEmail,
    name: '',
    department: DEPARTMENT_GROUP_ALL,
    role: 'admin',
    enabled: 'TRUE',
    note: '初回起動時に自動登録',
    createdAt: now,
    createdBy: 'system/bootstrap',
    updatedAt: now,
    updatedBy: 'system/bootstrap'
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (sheet.getLastRow() > 1 || hasAnyAuthConfiguration_()) return null;
    upsertObjectByKey_(sheet, 'email', normalizedEmail, record);
    if (historySheet) appendAuthHistoryIfChanged_(historySheet, null, record, 'system/bootstrap');
  } finally {
    lock.releaseLock();
  }

  return {
    email: normalizedEmail,
    department: record.department,
    role: record.role
  };
}

function hasAnyAuthConfiguration_() {
  const ss = getManualManagementSpreadsheetIfExists_();
  if (ss) {
    const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
    if (sheet && sheet.getLastRow() > 1) return true;
  }

  const data = loadJsonFile_(APP_CONFIG.AUTH_FILE_NAME);
  if (Array.isArray(data) && data.length > 0) return true;

  return DEFAULT_AUTH_RULES.length > 0;
}

function assertAdmin_(user) {
  if (!user || user.role !== 'admin') {
    throw new Error('この操作は管理者のみ実行できます。');
  }
}

/**
 * 閲覧・入力権限を取得する。
 * 管理テーブルを優先し、未設定の場合のみ JSON / 初期設定へフォールバックする。
 */
function loadAuthRules_() {
  const tableRules = loadAuthRulesFromTable_();
  if (tableRules.length > 0) return tableRules;

  const data = loadJsonFile_(APP_CONFIG.AUTH_FILE_NAME);
  if (Array.isArray(data) && data.length > 0) return data;

  return DEFAULT_AUTH_RULES;
}

function loadEmployeeMaster_() {
  const data = loadJsonFile_(APP_CONFIG.EMPLOYEE_MASTER_FILE_NAME);
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  return DEFAULT_EMPLOYEE_MASTER;
}

function saveSnapshot_(snapshot) {
  saveJsonFile_(APP_CONFIG.LATEST_FILE_NAME, snapshot);
  saveJsonFile_(getSnapshotFileNameForMonth_(snapshot.meta.targetMonth), snapshot);
  clearAvailableSnapshotMonthsCache_();
}

function getSnapshotFileNameForMonth_(targetMonth) {
  const normalized = normalizeTargetMonth_(targetMonth);
  if (!normalized) throw new Error('対象月の形式が不正です。');
  return `alert_snapshot_${normalized.replace('/', '-')}.json`;
}

function loadSnapshotByMonth_(targetMonth) {
  return loadJsonFile_(getSnapshotFileNameForMonth_(targetMonth));
}

function listAvailableSnapshotMonths_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('availableSnapshotMonths');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // キャッシュ破損時は通常取得に戻す。
    }
  }

  const folder = getOrCreateFolder_();
  const files = folder.getFiles();
  const monthMap = {};

  while (files.hasNext()) {
    const file = files.next();
    const match = String(file.getName() || '').match(/^alert_snapshot_(\d{4})-(\d{2})\.json$/);
    if (match) {
      monthMap[`${match[1]}/${match[2]}`] = true;
    }
  }

  const latest = loadJsonFile_(APP_CONFIG.LATEST_FILE_NAME);
  if (latest && latest.meta && latest.meta.targetMonth) {
    const latestMonth = normalizeTargetMonth_(latest.meta.targetMonth);
    if (latestMonth) monthMap[latestMonth] = true;
  }

  const months = Object.keys(monthMap).sort().reverse().map(month => ({
    value: month,
    label: formatYearMonthLabel_(month)
  }));
  cache.put('availableSnapshotMonths', JSON.stringify(months), 300);
  return months;
}

function clearAvailableSnapshotMonthsCache_() {
  CacheService.getScriptCache().remove('availableSnapshotMonths');
}

function formatYearMonthLabel_(targetMonth) {
  const normalized = normalizeTargetMonth_(targetMonth);
  if (!normalized) return String(targetMonth || '');
  const parts = normalized.split('/');
  return `${parts[0]}年${Number(parts[1])}月`;
}

function saveJsonFile_(fileName, data) {
  const folder = getOrCreateFolder_();
  const json = JSON.stringify(data);
  const existing = getFileByName_(folder, fileName);

  if (existing) {
    existing.setContent(json);
  } else {
    folder.createFile(fileName, json, MimeType.PLAIN_TEXT);
  }
}

function loadJsonFile_(fileName) {
  const folder = getOrCreateFolder_();
  const file = getFileByName_(folder, fileName);
  if (!file) return null;

  const text = file.getBlob().getDataAsString('UTF-8');
  if (!text) return null;

  return JSON.parse(text);
}

function getOrCreateFolder_() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const cachedFolderId = scriptProperties.getProperty('DRIVE_FOLDER_ID');

  if (cachedFolderId) {
    try {
      return DriveApp.getFolderById(cachedFolderId);
    } catch (e) {
      scriptProperties.deleteProperty('DRIVE_FOLDER_ID');
    }
  }

  const folders = DriveApp.getFoldersByName(APP_CONFIG.DRIVE_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(APP_CONFIG.DRIVE_FOLDER_NAME);
  scriptProperties.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function getFileByName_(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  return files.hasNext() ? files.next() : null;
}

function normalizeTargetMonth_(value) {
  const text = normalizeText_(value).replace(/-/g, '/');
  const match = text.match(/^(\d{4})\/0?(\d{1,2})$/);
  if (!match) return '';
  return `${match[1]}/${String(Number(match[2])).padStart(2, '0')}`;
}

function normalizeDateKey_(value) {
  const text = normalizeText_(value).replace(/-/g, '/');
  const match = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return '';
  return `${match[1]}/${String(Number(match[2])).padStart(2, '0')}/${String(Number(match[3])).padStart(2, '0')}`;
}

function normalizeText_(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}



function saveCompanyCalendar(payload) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  if (!payload || !payload.year || !payload.months) {
    throw new Error('会社カレンダーの保存データが不正です。');
  }

  const year = Number(payload.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('年度の指定が不正です。');
  }

  const months = {};
  let actualTotalDays = 0;

  for (let month = 1; month <= 12; month++) {
    const key = `${year}/${String(month).padStart(2, '0')}`;
    const value = Number(payload.months[key]);

    if (!Number.isFinite(value) || value <= 0 || value > 31) {
      throw new Error(`${key} の労働日数が不正です。`);
    }

    months[key] = value;
    actualTotalDays += value;
  }

  const expectedTotalDays = payload.expectedTotalDays ? Number(payload.expectedTotalDays) : null;

  if (expectedTotalDays !== null) {
    if (!Number.isInteger(expectedTotalDays) || expectedTotalDays <= 0 || expectedTotalDays > 366) {
      throw new Error('年間労働日数の指定が不正です。');
    }

    if (actualTotalDays !== expectedTotalDays) {
      throw new Error(`月別労働日数の合計（${actualTotalDays}日）が年間労働日数（${expectedTotalDays}日）と一致しません。保存前に確認してください。`);
    }
  }

  const data = {
    year,
    months,
    expectedTotalDays,
    actualTotalDays,
    totalCheckStatus: expectedTotalDays === null ? 'not_checked' : 'matched',
    note: String(payload.note || ''),
    sourceName: String(payload.sourceName || ''),
    importedText: String(payload.importedText || ''),
    importedTextRecorded: Boolean(payload.importedText),
    savedAt: Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss'),
    savedBy: user.email,
    version: '1.2'
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    saveJsonFile_(getCompanyCalendarFileName_(year), data);
    clearBusinessDayCacheForYear_(year);
  } finally {
    lock.releaseLock();
  }

  return data;
}

function getCompanyCalendar(year) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  const numericYear = Number(year);
  if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100) {
    throw new Error('年度の指定が不正です。');
  }

  return loadCompanyCalendar_(numericYear);
}

function loadCompanyCalendar_(year) {
  const data = loadJsonFile_(getCompanyCalendarFileName_(year));
  if (!data || !data.months) return null;
  return data;
}

function getCompanyCalendarFileName_(year) {
  return `${APP_CONFIG.COMPANY_CALENDAR_PREFIX}${year}.json`;
}

function getCompanyBusinessDayInfo_(year, month) {
  const calendar = loadCompanyCalendar_(year);
  if (!calendar || !calendar.months) return null;

  const key = `${year}/${String(month).padStart(2, '0')}`;
  const businessDays = Number(calendar.months[key]);

  if (!Number.isFinite(businessDays) || businessDays <= 0) return null;

  return {
    ok: true,
    targetMonth: key,
    businessDays,
    source: 'company_calendar',
    holidays: [],
    companyCalendar: {
      year: calendar.year,
      sourceName: calendar.sourceName || '',
      importedTextRecorded: Boolean(calendar.importedTextRecorded || calendar.importedText),
      savedAt: calendar.savedAt || '',
      savedBy: calendar.savedBy || ''
    },
    generatedAt: Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss')
  };
}

function clearBusinessDayCacheForYear_(year) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const prefix = BUSINESS_DAY_CACHE_PREFIX + String(year) + '_';

  Object.keys(all).forEach(key => {
    if (key.indexOf(prefix) === 0) {
      props.deleteProperty(key);
    }
  });
}


const JAPAN_HOLIDAY_CALENDAR_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const BUSINESS_DAY_CACHE_PREFIX = 'BUSINESS_DAYS_';

/**
 * 対象月の営業日数を返す。
 * 原則：土日祝日除外。
 * 祝日：Google日本の祝日カレンダーから取得。
 * 安全策：取得結果はScriptPropertiesへ月単位でキャッシュ。
 * フォールバック：取得失敗時は土日除外。
 */
function getBusinessDayInfo(targetMonth) {
  const normalized = normalizeTargetMonth_(targetMonth);
  if (!normalized) {
    throw new Error('対象月の形式が不正です。');
  }

  const parts = normalized.split('/').map(Number);
  const year = parts[0];
  const month = parts[1];

  // 最優先：会社の年間勤務カレンダー
  const companyInfo = getCompanyBusinessDayInfo_(year, month);
  if (companyInfo) {
    return companyInfo;
  }

  const cacheKey = BUSINESS_DAY_CACHE_PREFIX + normalized.replace('/', '_');
  const cache = CacheService.getScriptCache();

  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Number(parsed.businessDays) > 0) {
        return parsed;
      }
    } catch (e) {
      cache.remove(cacheKey);
    }
  }

  const result = calculateBusinessDaysWithHolidayFallback_(year, month);

  cache.put(cacheKey, JSON.stringify(result), 21600);
  return result;
}

function calculateBusinessDaysWithHolidayFallback_(year, month) {
  const timezone = APP_CONFIG.TIMEZONE;
  const fallbackBusinessDays = getWeekdayCountInMonth_(year, month);

  try {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);

    const calendar = CalendarApp.getCalendarById(JAPAN_HOLIDAY_CALENDAR_ID);
    if (!calendar) {
      return {
        ok: false,
        targetMonth: `${year}/${String(month).padStart(2, '0')}`,
        businessDays: fallbackBusinessDays,
        source: 'fallback_weekdays_calendar_not_found',
        holidays: [],
        generatedAt: Utilities.formatDate(new Date(), timezone, 'yyyy/MM/dd HH:mm:ss')
      };
    }

    const holidayMap = {};
    const holidays = [];

    calendar.getEvents(start, end).forEach(event => {
      const date = event.getStartTime();
      const key = Utilities.formatDate(date, timezone, 'yyyy/MM/dd');

      if (!holidayMap[key]) {
        holidayMap[key] = true;
        holidays.push({
          date: key,
          name: event.getTitle()
        });
      }
    });

    const lastDay = new Date(year, month, 0).getDate();
    let count = 0;

    for (let day = 1; day <= lastDay; day++) {
      const date = new Date(year, month - 1, day);
      const weekday = date.getDay();
      const key = Utilities.formatDate(date, timezone, 'yyyy/MM/dd');

      if (weekday === 0 || weekday === 6) continue;
      if (holidayMap[key]) continue;

      count++;
    }

    return {
      ok: true,
      targetMonth: `${year}/${String(month).padStart(2, '0')}`,
      businessDays: count,
      source: 'google_japan_holiday_calendar_cache',
      holidays,
      generatedAt: Utilities.formatDate(new Date(), timezone, 'yyyy/MM/dd HH:mm:ss')
    };
  } catch (e) {
    return {
      ok: false,
      targetMonth: `${year}/${String(month).padStart(2, '0')}`,
      businessDays: fallbackBusinessDays,
      source: 'fallback_weekdays_error',
      errorMessage: String(e && e.message ? e.message : e),
      holidays: [],
      generatedAt: Utilities.formatDate(new Date(), timezone, 'yyyy/MM/dd HH:mm:ss')
    };
  }
}

function getWeekdayCountInMonth_(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  let count = 0;

  for (let day = 1; day <= lastDay; day++) {
    const date = new Date(year, month - 1, day);
    const weekday = date.getDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }

  return count || 1;
}

/**
 * 祝日・営業日数キャッシュを削除するメンテナンス用関数。
 * 祝日データの再取得が必要な場合のみ手動実行してください。
 */
function clearBusinessDayCache() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(key => {
    if (key.indexOf(BUSINESS_DAY_CACHE_PREFIX) === 0) {
      props.deleteProperty(key);
    }
  });
}


/**
 * 保存先フォルダIDのキャッシュを削除するメンテナンス用関数。
 * 保存先がおかしい場合のみ手動実行してください。
 */
function clearDriveFolderCache() {
  PropertiesService.getScriptProperties().deleteProperty('DRIVE_FOLDER_ID');
}
/**
 * 手入力内容の保管テーブルを作成する初期設定コマンド。
 *
 * 目的：
 * - 36協定適用事前申請
 * - 特別条項の発動事由
 * - 健康福祉措置
 * - 備考
 *
 * 上記を、勤怠集計結果とは別テーブルで永続保管する。
 *
 * 実行方法：
 * Apps Script の関数選択で setupManualInputTables を選び、1回実行する。
 */
function setupManualInputTables() {
  const ss = getOrCreateManualInputSpreadsheet_();

  const currentSheet = ensureManualInputSheet_(
    ss,
    '手入力_現在値',
    [
      'key',
      'targetMonth',
      'employeeCode',
      'employeeName',
      'department',
      'departmentGroup',
      'agreement36',
      'specialReason',
      'healthMeasure',
      'note',
      'deleted',
      'createdAt',
      'createdBy',
      'updatedAt',
      'updatedBy'
    ]
  );

  const historySheet = ensureManualInputSheet_(
    ss,
    '手入力_履歴',
    [
      'historyId',
      'key',
      'targetMonth',
      'employeeCode',
      'employeeName',
      'department',
      'departmentGroup',
      'fieldName',
      'beforeValue',
      'afterValue',
      'action',
      'createdAt',
      'createdBy'
    ]
  );

  formatManualInputSheet_(currentSheet);
  formatManualInputSheet_(historySheet);

  PropertiesService.getScriptProperties().setProperty('MANUAL_INPUT_SPREADSHEET_ID', ss.getId());

  Logger.log('手入力管理テーブルを作成・確認しました。');
  Logger.log('Spreadsheet URL: ' + ss.getUrl());

  return {
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    currentSheetName: currentSheet.getName(),
    historySheetName: historySheet.getName()
  };
}


/**
 * 手入力管理用スプレッドシートを取得または作成する。
 */
function getOrCreateManualInputSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty('MANUAL_INPUT_SPREADSHEET_ID');

  if (cachedId) {
    try {
      return SpreadsheetApp.openById(cachedId);
    } catch (e) {
      props.deleteProperty('MANUAL_INPUT_SPREADSHEET_ID');
    }
  }

  const fileName = '勤怠アラート_手入力管理テーブル';
  const folder = getOrCreateFolder_();

  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    const file = files.next();
    const ss = SpreadsheetApp.openById(file.getId());
    props.setProperty('MANUAL_INPUT_SPREADSHEET_ID', ss.getId());
    return ss;
  }

  const ss = SpreadsheetApp.create(fileName);
  const file = DriveApp.getFileById(ss.getId());

  // 既存の保存フォルダへ移動
  try {
    file.moveTo(folder);
  } catch (e) {
    // moveTo が使えない環境向けの保険
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }

  props.setProperty('MANUAL_INPUT_SPREADSHEET_ID', ss.getId());
  return ss;
}


/**
 * 指定シートを取得または作成し、ヘッダーを設定する。
 */
function ensureManualInputSheet_(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const hasHeader = firstRow.some(value => String(value || '').trim() !== '');

  if (!hasHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    // ヘッダー不足がある場合は上書きして列ズレを防ぐ
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  // 余分な初期シートが空で残っている場合は削除
  const defaultSheet = ss.getSheetByName('シート1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  return sheet;
}


/**
 * テーブルの見た目・入力形式を整える。
 */
function formatManualInputSheet_(sheet) {
  const lastColumn = sheet.getLastColumn();

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastColumn)
    .setFontWeight('bold')
    .setBackground('#1f4e79')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');

  sheet.autoResizeColumns(1, lastColumn);

  // deleted 列がある場合、TRUE/FALSE のプルダウンを設定
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const deletedIndex = headers.indexOf('deleted') + 1;

  if (deletedIndex > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['FALSE', 'TRUE'], true)
      .setAllowInvalid(false)
      .build();

    sheet.getRange(2, deletedIndex, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
  }

  // targetMonth 列は文字列として扱う
  const targetMonthIndex = headers.indexOf('targetMonth') + 1;
  if (targetMonthIndex > 0) {
    sheet.getRange(2, targetMonthIndex, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  }

  // employeeCode 列も文字列として扱う
  const employeeCodeIndex = headers.indexOf('employeeCode') + 1;
  if (employeeCodeIndex > 0) {
    sheet.getRange(2, employeeCodeIndex, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  }
}


/**
 * 手入力管理テーブルのIDキャッシュを削除するメンテナンス用。
 * 保存先を作り直したい場合のみ実行。
 */
function clearManualInputSpreadsheetCache() {
  PropertiesService.getScriptProperties().deleteProperty('MANUAL_INPUT_SPREADSHEET_ID');
}
/*******************************************************
 * 管理画面・管理監督者入力保存 土台コード
 * 
 * 目的：
 * 1. 管理者が権限管理をできるようにする
 * 2. 管理監督者が自部署の備考等を保存できるようにする
 * 3. 再集計しても手入力内容が消えないようにする
 *******************************************************/

const MANAGEMENT_BASE = {
  MANUAL_CURRENT_SHEET: '手入力_現在値',
  MANUAL_HISTORY_SHEET: '手入力_履歴',
  AUTH_CURRENT_SHEET: '権限_現在値',
  AUTH_HISTORY_SHEET: '権限_履歴',
  ROLES: ['admin', 'manager', 'viewer'],
  MANUAL_FIELDS: ['agreement36', 'specialReason', 'healthMeasure', 'note']
};

function assertValidAuthScope_(role, department, prefix) {
  const messagePrefix = prefix || '';
  if (role === 'admin' && department !== DEPARTMENT_GROUP_ALL) {
    throw new Error(`${messagePrefix}admin 権限は表示範囲を「全社」にしてください。`);
  }
  if (role !== 'admin' && department === DEPARTMENT_GROUP_ALL) {
    throw new Error(`${messagePrefix}manager / viewer 権限には「全社」を設定できません。`);
  }
}

function getManagementSpreadsheetReady_() {
  setupManagementBaseTables();
  return getOrCreateManualInputSpreadsheet_();
}


/**
 * 管理用テーブルを初期化する。
 * 既に setupManualInputTables を実行済みでも、この関数を1回実行してください。
 */
function setupManagementBaseTables() {
  const ss = getOrCreateManualInputSpreadsheet_();

  const manualCurrent = ensureManualInputSheet_(
    ss,
    MANAGEMENT_BASE.MANUAL_CURRENT_SHEET,
    [
      'key',
      'targetMonth',
      'employeeCode',
      'employeeName',
      'department',
      'departmentGroup',
      'agreement36',
      'specialReason',
      'healthMeasure',
      'note',
      'deleted',
      'createdAt',
      'createdBy',
      'updatedAt',
      'updatedBy'
    ]
  );

  const manualHistory = ensureManualInputSheet_(
    ss,
    MANAGEMENT_BASE.MANUAL_HISTORY_SHEET,
    [
      'historyId',
      'key',
      'targetMonth',
      'employeeCode',
      'employeeName',
      'department',
      'departmentGroup',
      'fieldName',
      'beforeValue',
      'afterValue',
      'action',
      'createdAt',
      'createdBy'
    ]
  );

  const authCurrent = ensureManualInputSheet_(
    ss,
    MANAGEMENT_BASE.AUTH_CURRENT_SHEET,
    [
      'email',
      'name',
      'department',
      'role',
      'enabled',
      'note',
      'createdAt',
      'createdBy',
      'updatedAt',
      'updatedBy'
    ]
  );

  const authHistory = ensureManualInputSheet_(
    ss,
    MANAGEMENT_BASE.AUTH_HISTORY_SHEET,
    [
      'historyId',
      'email',
      'fieldName',
      'beforeValue',
      'afterValue',
      'action',
      'createdAt',
      'createdBy'
    ]
  );

  formatManualInputSheet_(manualCurrent);
  formatManualInputSheet_(manualHistory);
  formatManualInputSheet_(authCurrent);
  formatManualInputSheet_(authHistory);

  seedDefaultAuthRulesIfEmpty_();

  Logger.log('管理用テーブルを作成・確認しました。');
  Logger.log('Spreadsheet URL: ' + ss.getUrl());

  return {
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl()
  };
}


/**
 * 権限テーブルが空で、かつ DEFAULT_AUTH_RULES が設定されている場合のみ初期投入する。
 * 本番環境の実メールアドレスはコードではなく、権限管理テーブルまたは auth_rules.json で管理する。
 */
function seedDefaultAuthRulesIfEmpty_() {
  const ss = getOrCreateManualInputSpreadsheet_();
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  if (!sheet) return;

  if (sheet.getLastRow() > 1 || DEFAULT_AUTH_RULES.length === 0) return;

  const now = getNowText_();
  const rows = DEFAULT_AUTH_RULES.map(rule => [
    String(rule.email || '').trim().toLowerCase(),
    '',
    String(rule.department || ''),
    String(rule.role || 'viewer').toLowerCase(),
    'TRUE',
    '初期設定から登録',
    now,
    'system',
    now,
    'system'
  ]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

/**
 * 権限管理テーブルから有効な権限だけ取得する。
 */
function loadAuthRulesFromTable_() {
  const ss = getManualManagementSpreadsheetIfExists_();
  if (!ss) return [];

  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const rows = readSheetObjects_(sheet);

  return rows
    .filter(row => String(row.enabled || '').toUpperCase() !== 'FALSE')
    .map(row => ({
      email: String(row.email || '').trim().toLowerCase(),
      department: String(row.department || '').trim(),
      role: normalizeAuthRole_(row.role)
    }))
    .filter(row => row.email && row.department && row.role);
}


/**
 * 管理テーブルのスプレッドシートを取得する。
 * 存在しない場合は null を返す。
 */
function getManualManagementSpreadsheetIfExists_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('MANUAL_INPUT_SPREADSHEET_ID');
  if (!id) return null;

  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    props.deleteProperty('MANUAL_INPUT_SPREADSHEET_ID');
    return null;
  }
}


/**
 * 管理者用：権限一覧を取得する。
 */
function listAuthUsers() {
  const user = getCurrentUser_();
  assertAdmin_(user);

  return listAuthUsersInternal_();
}


function listAuthUsersInternal_() {
  const ss = getManagementSpreadsheetReady_();
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  if (!sheet) return [];

  return readSheetObjects_(sheet)
    .filter(row => row.email)
    .map(row => ({
      email: String(row.email || '').trim().toLowerCase(),
      name: String(row.name || ''),
      department: String(row.department || ''),
      role: String(row.role || ''),
      enabled: String(row.enabled || '').toUpperCase() !== 'FALSE',
      note: String(row.note || ''),
      updatedAt: String(row.updatedAt || ''),
      updatedBy: String(row.updatedBy || '')
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}


/**
 * 管理者用：権限ユーザーを追加・更新する。
 */
function saveAuthUser(payload) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  if (!payload) throw new Error('権限データがありません。');

  const email = String(payload.email || '').trim().toLowerCase();
  const name = String(payload.name || '').trim();
  const department = String(payload.department || '').trim();
  const role = String(payload.role || '').trim().toLowerCase();
  const enabled = payload.enabled === false ? 'FALSE' : 'TRUE';
  const note = String(payload.note || '').trim();

  if (!email || email.indexOf('@') === -1) {
    throw new Error('メールアドレスを正しく入力してください。');
  }

  if (!MANAGEMENT_BASE.ROLES.includes(role)) {
    throw new Error('権限は admin / manager / viewer のいずれかを指定してください。');
  }

  if (!createDepartmentGroupOptions_().includes(department)) {
    throw new Error('表示範囲は現在の部署グループ一覧から選択してください。新しい部署グループは、保存済みデータまたは最新スナップショットに反映後に選択できます。');
  }

  assertValidAuthScope_(role, department);

  const ss = getManagementSpreadsheetReady_();
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  const historySheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_HISTORY_SHEET);
  const now = getNowText_();

  const existingRowNumber = findRowByKey_(sheet, 'email', email);
  const before = existingRowNumber > 0 ? getObjectAtRow_(sheet, existingRowNumber) : null;

  const record = {
    email,
    name,
    department,
    role,
    enabled,
    note,
    createdAt: before ? before.createdAt : now,
    createdBy: before ? before.createdBy : user.email,
    updatedAt: now,
    updatedBy: user.email
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    upsertObjectByKey_(sheet, 'email', email, record);

    appendAuthHistoryIfChanged_(historySheet, before, record, user.email);
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    users: listAuthUsersInternal_()
  };
}


/**
 * 管理者用：権限ユーザーを一括追加・更新する。
 * CSV/Excel貼付で解析済みの配列を受け取り、既存メールは更新する。
 */
function bulkSaveAuthUsers(payload) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  const users = payload && Array.isArray(payload.users) ? payload.users : [];
  if (users.length === 0) throw new Error('一括登録する権限データがありません。');
  if (users.length > 500) throw new Error('一括登録は500件以内にしてください。');

  const availableDepartments = createDepartmentGroupOptions_();
  const currentUserEmail = String(user.email || '').trim().toLowerCase();
  const seenEmails = {};

  const normalizedUsers = users.map((item, index) => {
    const lineNumber = Number(item.sourceRowNumber || 0) > 0 ? Number(item.sourceRowNumber) : index + 2;
    const email = String(item.email || '').trim().toLowerCase();
    const name = String(item.name || '').trim();
    const department = String(item.department || '').trim();
    const role = String(item.role || 'manager').trim().toLowerCase();
    const enabled = item.enabled === false ? 'FALSE' : 'TRUE';
    const note = String(item.note || '').trim();

    if (!email || email.indexOf('@') <= 0 || email.indexOf('@') >= email.length - 1) {
      throw new Error(`${lineNumber}行目のメールアドレスが未入力、または正しくありません。メール欄を確認してください。`);
    }
    if (seenEmails[email]) {
      throw new Error(`${lineNumber}行目：同じメールアドレスが一括登録データ内で重複しています：${email}`);
    }
    seenEmails[email] = true;

    if (!MANAGEMENT_BASE.ROLES.includes(role)) {
      throw new Error(`${lineNumber}行目：権限は admin / manager / viewer のいずれかを指定してください。`);
    }
    if (!availableDepartments.includes(department)) {
      throw new Error(`${lineNumber}行目：表示範囲「${department}」は現在の部署グループ一覧にありません。`);
    }
    assertValidAuthScope_(role, department, `${lineNumber}行目：`);
    if (email === currentUserEmail && enabled === 'FALSE') {
      throw new Error(`${lineNumber}行目：自分自身の権限は無効化できません。`);
    }

    return {
      email,
      name,
      department,
      role,
      enabled,
      note
    };
  });

  const ss = getManagementSpreadsheetReady_();
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  const historySheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_HISTORY_SHEET);
  const now = getNowText_();

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const currentValues = sheet.getDataRange().getValues();
    const headers = currentValues[0].map(h => String(h || '').trim());
    const records = currentValues.slice(1)
      .filter(row => row.some(cell => String(cell || '').trim() !== ''))
      .map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          obj[header] = row[index];
        });
        return obj;
      });
    const recordIndexByEmail = {};
    records.forEach((record, index) => {
      const email = String(record.email || '').trim().toLowerCase();
      if (email && recordIndexByEmail[email] === undefined) recordIndexByEmail[email] = index;
    });

    const historyHeaders = historySheet.getRange(1, 1, 1, historySheet.getLastColumn()).getValues()[0]
      .map(h => String(h || '').trim());
    const historyFields = ['name', 'department', 'role', 'enabled', 'note'];
    const historyRecords = [];

    normalizedUsers.forEach(item => {
      const existingIndex = recordIndexByEmail[item.email];
      const before = existingIndex !== undefined ? records[existingIndex] : null;
      const record = Object.assign({}, item, {
        createdAt: before ? before.createdAt : now,
        createdBy: before ? before.createdBy : user.email,
        updatedAt: now,
        updatedBy: user.email
      });

      if (existingIndex !== undefined) {
        records[existingIndex] = record;
      } else {
        recordIndexByEmail[item.email] = records.length;
        records.push(record);
      }

      historyFields.forEach(field => {
        const beforeValue = before ? String(before[field] || '') : '';
        const afterValue = String(record[field] || '');
        if (beforeValue === afterValue) return;

        historyRecords.push({
          historyId: Utilities.getUuid(),
          email: record.email,
          fieldName: field,
          beforeValue,
          afterValue,
          action: before ? 'update' : 'create',
          createdAt: now,
          createdBy: user.email
        });
      });
    });

    const outputRows = records.map(record => headers.map(header => record[header] !== undefined ? record[header] : ''));
    if (outputRows.length > 0) {
      sheet.getRange(2, 1, outputRows.length, headers.length).setValues(outputRows);
    }

    if (historyRecords.length > 0) {
      const historyRows = historyRecords.map(record => historyHeaders.map(header => record[header] !== undefined ? record[header] : ''));
      historySheet.getRange(historySheet.getLastRow() + 1, 1, historyRows.length, historyHeaders.length).setValues(historyRows);
    }
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    importedCount: normalizedUsers.length,
    users: listAuthUsersInternal_()
  };
}


/**
 * 管理者用：ユーザー権限を無効化する。
 * 削除ではなく enabled = FALSE にする。
 */
function disableAuthUser(email) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  const targetEmail = String(email || '').trim().toLowerCase();

  if (!targetEmail) throw new Error('無効化するメールアドレスが指定されていません。');
  if (targetEmail === String(user.email || '').trim().toLowerCase()) {
    throw new Error('自分自身の権限は無効化できません。');
  }

  const ss = getManagementSpreadsheetReady_();
  const sheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_CURRENT_SHEET);
  const historySheet = ss.getSheetByName(MANAGEMENT_BASE.AUTH_HISTORY_SHEET);

  const rowNumber = findRowByKey_(sheet, 'email', targetEmail);
  if (rowNumber <= 0) throw new Error('対象ユーザーが見つかりません。');

  const before = getObjectAtRow_(sheet, rowNumber);
  const after = Object.assign({}, before, {
    enabled: 'FALSE',
    updatedAt: getNowText_(),
    updatedBy: user.email
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    setObjectAtRow_(sheet, rowNumber, after);
    appendAuthHistoryIfChanged_(historySheet, before, after, user.email);
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    users: listAuthUsersInternal_()
  };
}


/**
 * 管理監督者・管理者用：手入力内容を保存する。
 * 対象：
 * - agreement36
 * - specialReason
 * - healthMeasure
 * - note
 */
function saveManualInput(payload) {
  const user = getCurrentUser_();

  if (!payload) throw new Error('保存データがありません。');

  const targetMonth = normalizeTargetMonth_(payload.targetMonth);
  if (!targetMonth) throw new Error('対象月の形式が不正です。');

  const fieldName = String(payload.fieldName || '').trim();
  if (!MANAGEMENT_BASE.MANUAL_FIELDS.includes(fieldName)) {
    throw new Error('保存対象の項目が不正です。');
  }

  const value = String(payload.value || '').trim();
  const payloadRow = payload.row || {};

  const authoritativeRow = assertCanEditManualInput_(user, targetMonth, payloadRow);

  const employeeCode = String(authoritativeRow.employeeCode || payloadRow.employeeCode || '').trim();
  const employeeName = String(authoritativeRow.employeeName || payloadRow.employeeName || '').trim();
  const department = String(authoritativeRow.department || payloadRow.department || '').trim();
  const departmentGroup = String(authoritativeRow.departmentGroup || payloadRow.departmentGroup || '').trim();

  if (!employeeCode && !employeeName) {
    throw new Error('社員コードまたは社員名を特定できません。');
  }

  const key = createManualInputKey_(targetMonth, employeeCode, employeeName);

  const ss = getManagementSpreadsheetReady_();
  const currentSheet = ss.getSheetByName(MANAGEMENT_BASE.MANUAL_CURRENT_SHEET);
  const historySheet = ss.getSheetByName(MANAGEMENT_BASE.MANUAL_HISTORY_SHEET);

  const existingRowNumber = findRowByKey_(currentSheet, 'key', key);
  const before = existingRowNumber > 0 ? getObjectAtRow_(currentSheet, existingRowNumber) : null;

  const beforeValue = before ? String(before[fieldName] || '') : '';

  const now = getNowText_();

  const record = Object.assign(
    {
      key,
      targetMonth,
      employeeCode,
      employeeName,
      department,
      departmentGroup,
      agreement36: '',
      specialReason: '',
      healthMeasure: '',
      note: '',
      deleted: 'FALSE',
      createdAt: now,
      createdBy: user.email,
      updatedAt: now,
      updatedBy: user.email
    },
    before || {}
  );

  record.targetMonth = targetMonth;
  record.employeeCode = employeeCode;
  record.employeeName = employeeName;
  record.department = department;
  record.departmentGroup = departmentGroup;
  record[fieldName] = value;
  record.deleted = 'FALSE';
  record.updatedAt = now;
  record.updatedBy = user.email;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    upsertObjectByKey_(currentSheet, 'key', key, record);

    if (beforeValue !== value) {
      const action = !beforeValue && value ? 'create' : value ? 'update' : 'delete';

      appendManualHistory_(historySheet, {
        historyId: Utilities.getUuid(),
        key,
        targetMonth,
        employeeCode,
        employeeName,
        department,
        departmentGroup,
        fieldName,
        beforeValue,
        afterValue: value,
        action,
        createdAt: now,
        createdBy: user.email
      });
    }
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    key,
    targetMonth,
    employeeCode,
    employeeName,
    department,
    departmentGroup,
    agreement36: record.agreement36,
    specialReason: record.specialReason,
    healthMeasure: record.healthMeasure,
    note: record.note,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy
  };
}


/**
 * 対象月の手入力データを取得する。
 * 管理者は全件、manager/viewer は自部署のみ。
 */
function loadManualInputs(targetMonth) {
  const user = getCurrentUser_();

  const normalizedMonth = normalizeTargetMonth_(targetMonth);
  if (!normalizedMonth) throw new Error('対象月の形式が不正です。');

  const records = loadManualInputsAllForMonth_(normalizedMonth)
    .filter(record => canViewManualInput_(user, record));

  const map = {};
  records.forEach(record => {
    map[record.key] = record;
  });

  return {
    ok: true,
    targetMonth: normalizedMonth,
    records,
    map
  };
}


/**
 * クライアント側で再集計した結果に、保存済み手入力を結合する。
 * 管理者の再集計時に使用する想定。
 */
function applyManualInputsToRows(payload) {
  const user = getCurrentUser_();
  assertAdmin_(user);

  if (!payload || !Array.isArray(payload.rows)) {
    throw new Error('結合対象の行データが不正です。');
  }

  const targetMonth = normalizeTargetMonth_(payload.targetMonth);
  if (!targetMonth) throw new Error('対象月の形式が不正です。');

  return mergeManualInputsToRows_(payload.rows, targetMonth);
}

/**
 * クライアント側に返す権限情報。
 */
function createClientPermissions_(user) {
  return {
    canAdmin: user && user.role === 'admin',
    canEditManualInputs: user && (user.role === 'admin' || user.role === 'manager'),
    canManageAuth: user && user.role === 'admin'
  };
}


/**
 * 手入力を集計結果に結合する。
 */
function mergeManualInputsToRows_(rows, targetMonth) {
  const normalizedMonth = normalizeTargetMonth_(targetMonth);
  if (!normalizedMonth || !Array.isArray(rows)) return rows || [];

  const manualMap = {};
  loadManualInputsAllForMonth_(normalizedMonth).forEach(record => {
    manualMap[record.key] = record;
  });

  return rows.map(row => {
    const employeeCode = String(row.employeeCode || '').trim();
    const employeeName = String(row.employeeName || '').trim();

    const key = createManualInputKey_(normalizedMonth, employeeCode, employeeName);
    const fallbackKey = createManualInputKey_(normalizedMonth, '', employeeName);

    const manual = employeeCode ? (manualMap[key] || manualMap[fallbackKey]) : manualMap[fallbackKey];

    if (!manual) return row;

    const merged = Object.assign({}, row, {
      agreement36: manual.agreement36 || '',
      specialReason: manual.specialReason || '',
      healthMeasure: manual.healthMeasure || '',
      note: manual.note || ''
    });

    merged.missingItems = calculateMissingItemsServer_(merged);

    return merged;
  });
}


/**
 * 対象月の手入力データを全件取得する。
 */
function loadManualInputsAllForMonth_(targetMonth) {
  const ss = getManualManagementSpreadsheetIfExists_();
  if (!ss) return [];

  const sheet = ss.getSheetByName(MANAGEMENT_BASE.MANUAL_CURRENT_SHEET);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  return readSheetObjects_(sheet)
    .filter(row => String(row.targetMonth || '') === targetMonth)
    .filter(row => String(row.deleted || '').toUpperCase() !== 'TRUE');
}


/**
 * 手入力の保存権限を確認する。
 * admin：全社編集可
 * manager：自部署のみ編集可
 * viewer：編集不可
 */
function assertCanEditManualInput_(user, targetMonth, payloadRow) {
  if (!user) throw new Error('ユーザー情報を取得できません。');

  if (user.role === 'admin') {
    return resolveAuthoritativeRow_(targetMonth, payloadRow) || payloadRow;
  }

  if (user.role !== 'manager') {
    throw new Error('このユーザーは入力内容を保存できません。');
  }

  const authoritativeRow = resolveAuthoritativeRow_(targetMonth, payloadRow);

  if (!authoritativeRow) {
    throw new Error('保存対象の社員を現在の保存済みデータから確認できません。');
  }

  if (String(authoritativeRow.departmentGroup || '') !== String(user.department || '')) {
    throw new Error('自部署以外の社員データは保存できません。');
  }

  return authoritativeRow;
}


/**
 * 最新スナップショットから社員行を確認する。
 * ブラウザ側の改ざん対策として、departmentGroup はサーバー側データを優先する。
 */
function resolveAuthoritativeRow_(targetMonth, payloadRow) {
  const normalizedTargetMonth = normalizeTargetMonth_(targetMonth);
  let snapshot = normalizedTargetMonth ? loadSnapshotByMonth_(normalizedTargetMonth) : null;
  if (!snapshot) snapshot = loadJsonFile_(APP_CONFIG.LATEST_FILE_NAME);
  if (!snapshot || !Array.isArray(snapshot.rows)) return null;

  const snapshotMonth = snapshot.meta && snapshot.meta.targetMonth
    ? normalizeTargetMonth_(snapshot.meta.targetMonth)
    : '';

  if (snapshotMonth && normalizedTargetMonth && snapshotMonth !== normalizedTargetMonth) {
    return null;
  }

  const employeeCode = String(payloadRow.employeeCode || '').trim();
  const employeeName = String(payloadRow.employeeName || '').trim();
  const departmentGroup = String(payloadRow.departmentGroup || '').trim();

  if (!employeeCode && !employeeName) return null;

  let matches = snapshot.rows.filter(row => {
    if (employeeCode) return String(row.employeeCode || '').trim() === employeeCode;
    return String(row.employeeName || '').trim() === employeeName;
  });

  if (departmentGroup) {
    matches = matches.filter(row => String(row.departmentGroup || '').trim() === departmentGroup);
  }

  return matches.length === 1 ? matches[0] : null;
}


function canViewManualInput_(user, record) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return String(record.departmentGroup || '') === String(user.department || '');
}


function createManualInputKey_(targetMonth, employeeCode, employeeName) {
  const id = String(employeeCode || '').trim() || String(employeeName || '').trim();
  return `${targetMonth}__${id}`;
}


function calculateMissingItemsServer_(row) {
  const missing = [];
  const forecast60 = Number(row.forecast60 || 0);
  const forecast80 = Number(row.forecast80 || 0);

  if (row.actualAlert || row.forecastAlert) {
    if (!row.agreement36) missing.push('36協定');
  }

  if (forecast60 > 60 || forecast80 > 80) {
    if (!row.specialReason) missing.push('発動事由');
    if (!row.healthMeasure) missing.push('健康福祉措置');
  }

  return missing;
}


/*******************************************************
 * 共通：シート操作ヘルパー
 *******************************************************/

function readSheetObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values || values.length <= 1) return [];

  const headers = values[0].map(h => String(h || '').trim());
  assertValidSheetHeaders_(sheet, headers);

  return values.slice(1)
    .filter(row => row.some(cell => String(cell || '').trim() !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index];
      });
      return obj;
    });
}


function assertValidSheetHeaders_(sheet, headers) {
  const seen = {};
  headers.forEach((header, index) => {
    if (!header) {
      throw new Error(`${sheet.getName()} の ${index + 1} 列目のヘッダーが空です。`);
    }
    if (seen[header]) {
      throw new Error(`${sheet.getName()} のヘッダー「${header}」が重複しています。`);
    }
    seen[header] = true;
  });
}


function getHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());
  assertValidSheetHeaders_(sheet, headers);

  const map = {};
  headers.forEach((header, index) => {
    map[header] = index + 1;
  });

  return map;
}


function findRowByKey_(sheet, keyColumnName, keyValue) {
  const map = getHeaderMap_(sheet);
  const column = map[keyColumnName];
  if (!column) throw new Error(`${sheet.getName()} に ${keyColumnName} 列がありません。`);

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;

  const finder = sheet
    .getRange(2, column, lastRow - 1, 1)
    .createTextFinder(String(keyValue))
    .matchEntireCell(true)
    .findNext();

  return finder ? finder.getRow() : -1;
}


function getObjectAtRow_(sheet, rowNumber) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  const values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];

  const obj = {};
  headers.forEach((header, index) => {
    obj[header] = values[index];
  });

  return obj;
}


function setObjectAtRow_(sheet, rowNumber, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  const row = headers.map(header => obj[header] !== undefined ? obj[header] : '');
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
}


function upsertObjectByKey_(sheet, keyColumnName, keyValue, obj) {
  const rowNumber = findRowByKey_(sheet, keyColumnName, keyValue);

  if (rowNumber > 0) {
    setObjectAtRow_(sheet, rowNumber, obj);
  } else {
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || '').trim());

    const row = headers.map(header => obj[header] !== undefined ? obj[header] : '');
    sheet.appendRow(row);
  }
}


function appendManualHistory_(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h || '').trim());

  const row = headers.map(header => obj[header] !== undefined ? obj[header] : '');
  sheet.appendRow(row);
}


function appendAuthHistoryIfChanged_(sheet, before, after, userEmail) {
  const now = getNowText_();

  const fields = ['name', 'department', 'role', 'enabled', 'note'];

  fields.forEach(field => {
    const beforeValue = before ? String(before[field] || '') : '';
    const afterValue = String(after[field] || '');

    if (beforeValue === afterValue) return;

    const action = before ? 'update' : 'create';

    const obj = {
      historyId: Utilities.getUuid(),
      email: after.email,
      fieldName: field,
      beforeValue,
      afterValue,
      action,
      createdAt: now,
      createdBy: userEmail
    };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h || '').trim());

    const row = headers.map(header => obj[header] !== undefined ? obj[header] : '');
    sheet.appendRow(row);
  });
}


function getNowText_() {
  return Utilities.formatDate(new Date(), APP_CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
}
