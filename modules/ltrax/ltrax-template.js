/**
 * LTRAX "Funct" tab template (LCDS fy2027 form: /Assessment/fy2027/Function.jsp)
 * Captured from a live admission assessment on 2026-10-23 (read only, nothing changed).
 *
 * Purpose: one entry per LTRAX field, showing what to pull from WellSky and how to
 * code it. Fill in each `wellsky` block once you've mapped where it lives in WellSky.
 *
 * Conventions seen on the page:
 *  - "-32768" is LTRAX's value for "not assessed" / blank (selects AND radios).
 *  - On an ADMISSION assessment every Discharge control is disabled. Expect the reverse
 *    (Discharge enabled) on a discharge assessment. Confirm on a real discharge record.
 *  - All fields sit in one form: <form name="frmIRFPAI" method="post">. No onchange
 *    handlers are on the selects, so values save when you leave the tab
 *    (left-nav button or "Next: Pain/Falls").
 *  - After setting a value from code, dispatch a 'change' event in case LTRAX scripts
 *    enable or disable dependent fields (Q1 -> R/RR1/S/SS1, GG0110 A-C -> Z).
 */

// ---------- Launch screen: which patients need work ----------
export const LAUNCH_SCREEN = {
  url: '/LaunchScreen.jsp',
  tables: 'table.assess', // 3 of them: Pre-Admission, Admission, Discharge (by header text)
  admission: {
    header: 'Admission Assessments',
    statusColumn: 'Admit Status',
    needsWork: 'status cell text is blank', // that cell carries class "awaiting_completion"
  },
  discharge: {
    header: 'Discharge Assessments',
    statusColumn: 'Disch. Status',
    needsWork: 'status cell text is blank',
  },
  openPatient: 'click the patient-name <a> (it navigates the same tab to /Assessment/IRFPAI_main.jsp)',
  warning: 'Only one assessment window at a time. A second window triggers the "Multiple Window Warning" and can log you out.',
};

// ---------- Assessment left nav: tab completion colors ----------
export const TAB_STATUS = {
  button: 'input#Funct_8[name="Funct"]', // the "Funct" button
  colorSwatch: '#FunctTabColor', // the <input> right before the button; read backgroundColor
  colors: {
    'rgb(33, 184, 35)': 'complete (green)',
    'rgb(252, 217, 7)': 'incomplete (yellow): open it and fill',
    'rgb(170, 170, 170)': 'n/a or locked (gray)',
  },
};

// ---------- Leaving the Funct tab: save, verify, release ----------
// 1. Click "Next: Pain/Falls" (or any other left-nav tab). This posts frmIRFPAI, which saves Funct.
// 2. On the page that loads, read #FunctTabColor. If it isn't green, log it as incomplete.
// 3. Click HOME (top-left nav button, value "HOME") to close the assessment and release the lock
//    so other users can open it.
export const EXIT_ROUTINE = {
  saveButton: 'input[name="btnNextIRFPAISection"][value="Next: Pain/Falls"]',
  homeButton: '#btnHomePage', // <input type="BUTTON" id="btnHomePage" value="HOME">
  greenColor: 'rgb(33, 184, 35)',
};

export async function exitFunctTab(patientName, log = []) {
  const waitForLoad = () => new Promise(r => window.addEventListener('load', r, { once: true }));
  // Step 1 and step 2 need to run across a page load, so in a real content script
  // save a "pendingCheck" flag to chrome.storage before clicking and finish the work on the next page.
  document.querySelector(EXIT_ROUTINE.saveButton)?.click();
  await waitForLoad();
  const swatch = document.getElementById('FunctTabColor');
  const color = swatch && getComputedStyle(swatch).backgroundColor;
  if (color !== EXIT_ROUTINE.greenColor) {
    log.push({ patient: patientName, tab: 'Funct', status: 'NOT COMPLETE', color, at: new Date().toISOString() });
  }
  document.querySelector(EXIT_ROUTINE.homeButton)?.click();
  return log;
}

// Shared code lists
const PERF_CODES = { // GG0130 / GG0170 performance (6-point scale + activity-not-attempted codes)
  6: 'Independent', 5: 'Setup or clean-up', 4: 'Supervision or touching assistance',
  3: 'Partial/moderate assistance', 2: 'Substantial/maximal assistance', 1: 'Dependent',
  7: 'Patient refused', 9: 'Not applicable (not done prior to current illness)',
  10: 'Not attempted due to environmental limitations',
  88: 'Not attempted due to medical condition or safety concerns',
  '-32768': 'not assessed (leave blank)',
};
const perf = (code, label, admit, disch, wellskyHint) => ({
  item: code, label, type: 'select', codes: PERF_CODES,
  ltrax: { admit, disch },
  wellsky: { source: wellskyHint, field: 'TODO', note: 'TODO' },
});

// ---------- The template ----------
export const FUNCT_TEMPLATE = [
  // GG0100: Prior Functioning (admission only)
  {
    item: 'GG0100B', label: 'Prior Functioning: Indoor Mobility (Ambulation)', type: 'select',
    codes: { 3: 'Independent', 2: 'Needed some help', 1: 'Dependent', 8: 'Unknown', 9: 'Not applicable', '-32768': 'not assessed' },
    ltrax: { admit: 'selIndoorMobilityAmbulation' },
    wellsky: { source: 'PT eval: prior level of function / home ambulation', field: 'TODO', note: 'TODO' },
  },

  // GG0110: Prior Device Use (admission only, radios: 1=Yes, 0=No, -32768=Not assessed)
  ...[
    ['GG0110A', 'Manual wheelchair', 'radPriorDeviceUseManualWheelChair'],
    ['GG0110B', 'Motorized wheelchair and/or scooter', 'radPriorDeviceUseMotorizedWheelChair'],
    ['GG0110C', 'Mechanical lift', 'radPriorDeviceUseMechanicalLift'],
  ].map(([item, label, name]) => ({
    item, label: `Prior Device Use: ${label}`, type: 'radio',
    codes: { 1: 'Yes', 0: 'No', '-32768': 'Not assessed' },
    ltrax: { admit: name },
    wellsky: { source: 'PT/OT eval: prior DME / device use', field: 'TODO', note: 'TODO' },
  })),
  {
    item: 'GG0110Z', label: 'Prior Device Use: None of the above', type: 'radio (auto)',
    ltrax: { admit: 'radPriorDeviceUseNOTA' },
    wellsky: null,
    note: 'Disabled and computed by LTRAX from A-C. Do not set it.',
  },

  // GG0130: Self-Care (OT is the usual source)
  perf('GG0130A', 'Eating', 'selAdmitSelfCarePerformanceEating', 'selDischargeSelfCarePerformanceEating', 'OT eval/DC: Section GG self-care'),
  perf('GG0130B', 'Oral hygiene', 'selAdmitSelfCarePerformanceOralHygiene', 'selDischargeSelfCarePerformanceOralHygiene', 'OT eval/DC: Section GG self-care'),
  perf('GG0130C', 'Toileting hygiene', 'selAdmitSelfCarePerformanceToiletingHygiene', 'selDischargeSelfCarePerformanceToiletingHygiene', 'OT eval/DC: Section GG self-care'),

  // GG0170: Mobility (PT is the usual source; check PT vs OT on overlapping transfers)
  perf('GG0170A', 'Roll left and right', 'selMobilityRollAdmit', 'selMobilityRollDisch', 'PT eval/DC: bed mobility'),
  perf('GG0170B', 'Sit to lying', 'selMobilityLieDownAdmit', 'selMobilityLieDownDisch', 'PT eval/DC: bed mobility'),
  perf('GG0170C', 'Lying to sitting on side of bed', 'selMobilitySitUpAdmit', 'selMobilitySitUpDisch', 'PT eval/DC: bed mobility'),
  perf('GG0170D', 'Sit to stand', 'selAdmitMobilityPerformanceSitToStand', 'selDischargeMobilityPerformanceSitToStand', 'PT eval/DC: transfers'),
  perf('GG0170E', 'Chair/bed-to-chair transfer', 'selAdmitMobilityPerformanceChairBedToChairTransfer', 'selDischargeMobilityPerformanceChairBedToChairTransfer', 'PT eval/DC: transfers'),
  perf('GG0170F', 'Toilet transfer', 'selAdmitMobilityPerformanceToiletTransfer', 'selDischargeMobilityPerformanceToiletTransfer', 'PT/OT eval/DC: transfers'),
  perf('GG0170G', 'Car transfer', 'selGG0170G1_Mobility_Car_Admit', 'selGG0170G3_Mobility_Car_Disch', 'PT eval/DC: car transfer (often 10/88 in hospital)'),
  perf('GG0170I', 'Walk 10 feet', 'selAdmitMobilityPerformanceWalk10Feet', 'selDischargeMobilityPerformanceWalk10Feet', 'PT eval/DC: gait'),
  perf('GG0170J', 'Walk 50 feet with two turns', 'selAdmitMobilityPerformanceWalk50FeetTwoTurns', 'selDischargeMobilityPerformanceWalk50FeetTwoTurns', 'PT eval/DC: gait'),
  perf('GG0170K', 'Walk 150 feet', 'selAdmitMobilityPerformanceWalk150Feet', 'selDischargeMobilityPerformanceWalk150Feet', 'PT eval/DC: gait'),
  perf('GG0170L', 'Walking 10 feet on uneven surfaces', 'selGG0170L1_Mobility_Uneven_Admit', 'selGG0170L3_Mobility_Uneven_Disch', 'PT eval/DC: gait'),
  perf('GG0170M', '1 step (curb)', 'selGG0170M1_Mobility_1step_Admit', 'selGG0170M3_Mobility_1step_Disch', 'PT eval/DC: stairs'),
  perf('GG0170N', '4 steps', 'selGG0170N1_Mobility_4steps_Admit', 'selGG0170N3_Mobility_4steps_Disch', 'PT eval/DC: stairs'),
  perf('GG0170O', '12 steps', 'selGG0170O1_Mobility_12steps_Admit', 'selGG0170O3_Mobility_12steps_Disch', 'PT eval/DC: stairs'),
  perf('GG0170P', 'Picking up object', 'selGG0170P1_Mobility_Pickup_Admit', 'selGG0170P3_Mobility_Pickup_Disch', 'PT eval/DC'),

  // Wheelchair gate: Q1/Q3 controls whether R, RR1, S and SS1 are enabled
  {
    item: 'GG0170Q', label: 'Does the patient use a wheelchair and/or scooter?', type: 'radio',
    codes: { 0: 'No', 1: 'Yes', '-32768': 'Not assessed' },
    ltrax: { admit: 'radWheelchairScooterUseAdmit', disch: 'radWheelchairScooterUseDischarge' },
    wellsky: { source: 'PT eval/DC: wheelchair mobility', field: 'TODO', note: 'TODO' },
    gates: ['GG0170R', 'GG0170RR', 'GG0170S', 'GG0170SS'],
    note: 'Set Q first. If No, leave R/RR/S/SS alone (LTRAX disables them).',
  },
  { ...perf('GG0170R', 'Wheel 50 feet with two turns', 'selAdmitMobilityPerformanceWheel50FeetTwoTurns', 'selDischargeMobilityPerformanceWheel50FeetTwoTurns', 'PT eval/DC: wheelchair mobility'), dependsOn: 'GG0170Q = 1' },
  {
    item: 'GG0170RR', label: 'Wheel 50 ft: type of wheelchair/scooter', type: 'radio', dependsOn: 'GG0170Q = 1',
    codes: { 1: 'Manual', 2: 'Motorized', '-32768': 'Not assessed' },
    ltrax: { admit: 'radWheel50ChairScooterTypeAdmit', disch: 'radWheel50ChairScooterTypeDischarge' },
    wellsky: { source: 'PT eval/DC: wheelchair type', field: 'TODO', note: 'TODO' },
  },
  { ...perf('GG0170S', 'Wheel 150 feet', 'selAdmitMobilityPerformanceWheel150Feet', 'selDischargeMobilityPerformanceWheel150Feet', 'PT eval/DC: wheelchair mobility'), dependsOn: 'GG0170Q = 1' },
  {
    item: 'GG0170SS', label: 'Wheel 150 ft: type of wheelchair/scooter', type: 'radio', dependsOn: 'GG0170Q = 1',
    codes: { 1: 'Manual', 2: 'Motorized', '-32768': 'Not assessed' },
    ltrax: { admit: 'radWheel150ChairScooterTypeAdmit', disch: 'radWheel150ChairScooterTypeDischarge' },
    wellsky: { source: 'PT eval/DC: wheelchair type', field: 'TODO', note: 'TODO' },
  },

  // Section H: Bladder and Bowel (same tab; usually nursing, not therapy)
  {
    item: 'H0350', label: 'Bladder continence', type: 'select',
    codes: { 0: 'Always continent', 1: 'Stress incontinence only', 2: 'Incontinent less than daily', 3: 'Incontinent daily', 4: 'Always incontinent', 5: 'No urine output', 9: 'Not applicable' },
    ltrax: { admit: 'selBladderContinenceAdmit', disch: 'selBladderContinenceDischarge' },
    wellsky: { source: 'Nursing assessment (confirm whether therapy owns this)', field: 'TODO', note: 'TODO' },
  },
  {
    item: 'H0400', label: 'Bowel continence', type: 'select',
    codes: { 0: 'Always continent', 1: 'Occasionally incontinent', 2: 'Frequently incontinent', 3: 'Always incontinent', 9: 'Not rated', '-32768': 'not assessed' },
    ltrax: { admit: 'selBowelContinenceAdmit' }, // admission only on this form
    wellsky: { source: 'Nursing assessment (confirm whether therapy owns this)', field: 'TODO', note: 'TODO' },
  },
];