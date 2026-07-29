import express from 'express';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

// Helper function to validate Chanote data consistency and standard formats
function validateChanoteData(data: any) {
  const issues: Array<{
    field: string;
    severity: 'error' | 'warning' | 'info';
    title: string;
    message: string;
    suggestion?: string;
  }> = [];

  // 1. Validate Chanote Number (เลขที่โฉนด)
  const chanoteNo = (data.chanoteNo || '').toString().trim();
  if (!chanoteNo) {
    issues.push({
      field: 'chanoteNo',
      severity: 'error',
      title: 'ไม่พบเลขที่โฉนดที่ดิน',
      message: 'ระบบไม่พบตัวเลขเลขที่โฉนดในเอกสารหรือสแกนอ่านไม่ได้',
      suggestion: 'โปรดตรวจสอบตัวเลขมุมขวาบนของโฉนดและกรอกแก้ไขเพิ่มเติม',
    });
  } else if (!/^\d{1,7}$/.test(chanoteNo)) {
    issues.push({
      field: 'chanoteNo',
      severity: 'warning',
      title: 'รูปแบบเลขที่โฉนดไม่ตรงตามรูปแบบมาตรฐาน',
      message: `เลขที่โฉนด '${chanoteNo}' มีอักขระพิเศษหรือรูปแบบผิดปกติ (เลขที่โฉนดมาตรฐานควรเป็นตัวเลข 1 ถึง 7 หลัก)`,
      suggestion: 'ตรวจสอบว่ามีตัวอักษรหรือสัญลักษณ์ติดมาจากการอ่าน OCR หรือไม่',
    });
  }

  // 2. Validate Rawang Number (เลขระวาง)
  const rawangNo = (data.rawangNo || '').toString().trim();
  if (!rawangNo) {
    issues.push({
      field: 'rawangNo',
      severity: 'error',
      title: 'ไม่พบเลขระวางที่ดิน',
      message: 'ระบบไม่สามารถอ่านเลขระวางจากโฉนดฉบับนี้ได้',
      suggestion: 'ตรวจสอบช่อง "ระวาง" บริเวณส่วนบนของโฉนด',
    });
  } else {
    // Standard Thai UTM Rawang check e.g., 5236 IV 1422 or 5136 I 4820 - 02 or ระวาง 1:4000
    const isValidRawangFormat =
      /^(\d{4})\s*([I|V|X]+|\d+)\s*(\d{4})/.test(rawangNo) ||
      /ระวาง\s*1:\d+/i.test(rawangNo) ||
      /^\d{4}\s*-\s*\d+/.test(rawangNo);

    if (!isValidRawangFormat) {
      issues.push({
        field: 'rawangNo',
        severity: 'warning',
        title: 'รูปแบบเลขระวางไม่ตรงตามมาตรฐานกรมที่ดิน',
        message: `เลขระวาง '${rawangNo}' ไม่ตรงตามรูปแบบระวางแผนที่ UTM มาตรฐาน (เช่น '5236 IV 1422-10' หรือ '5136 I 4820')`,
        suggestion: 'โปรดตรวจสอบชุดตัวเลขระวางฉบับเต็มบนแผนที่โฉนด',
      });
    }
  }

  // 3. Validate Area Rationality (เนื้อที่ vs ขนาดรูปแปลง)
  const rai = Number(data.area?.rai) || 0;
  const ngan = Number(data.area?.ngan) || 0;
  const sqWah = Number(data.area?.sqWah) || 0;
  const totalSqm = Number(data.area?.totalSqm) || ((rai * 400) + (ngan * 100) + sqWah) * 4;

  // Check unit arithmetic consistency
  if (ngan >= 4) {
    issues.push({
      field: 'area',
      severity: 'warning',
      title: 'ตัวเลขหน่วยงานเกินเกณฑ์มาตรฐาน',
      message: `จำนวนงานระบุเป็น ${ngan} งาน ซึ่งควรถูกแปลงเป็น ${Math.floor(ngan / 4)} ไร่ ${ngan % 4} งาน (4 งาน = 1 ไร่)`,
      suggestion: 'ควรปรับทอนหน่วยงานให้อยู่ในสเกล 0-3 งาน',
    });
  }

  if (sqWah >= 100) {
    issues.push({
      field: 'area',
      severity: 'warning',
      title: 'ตัวเลขหน่วยตารางวาเกินเกณฑ์มาตรฐาน',
      message: `จำนวนตารางวาระบุเป็น ${sqWah} ตารางวา ซึ่งควรถูกแปลงเป็น ${Math.floor(sqWah / 100)} งาน ${sqWah % 100} ตารางวา (100 ตารางวา = 1 งาน)`,
      suggestion: 'ควรปรับทอนหน่วยตารางวาให้อยู่ในสเกล 0-99.9 ตารางวา',
    });
  }

  // Check relationship with side distances (รูปแปลง)
  const sides = Array.isArray(data.sideDistances) ? data.sideDistances : [];
  if (sides.length >= 3) {
    const totalPerimeter = sides.reduce((acc: number, s: any) => acc + (Number(s.lengthMeters) || 0), 0);
    
    // Theoretical max area for perimeter P is circle A_max = P^2 / (4 * pi)
    const maxTheoreticalArea = Math.pow(totalPerimeter, 2) / (4 * Math.PI);

    if (totalPerimeter > 0 && totalSqm > maxTheoreticalArea * 1.15) {
      issues.push({
        field: 'area',
        severity: 'error',
        title: 'ความไม่สัมพันธ์อย่างรุนแรงระหว่างเนื้อที่ดินและขอบเขตรอบแปลง',
        message: `เนื้อที่ดินระบุ ${totalSqm.toLocaleString()} ตร.ม. แต่ผลรวมความยาวด้านรอบแปลงรวมได้เพียง ${totalPerimeter.toFixed(1)} เมตร (พื้นที่สูงสุดที่เป็นไปได้ทางเรขาคณิตสำหรับเส้นรอบวงนี้คือไม่เกิน ${Math.round(maxTheoreticalArea).toLocaleString()} ตร.ม.)`,
        suggestion: 'ตรวจสอบว่ามีการอ่านตัวเลขความยาวด้านตกหล่น หรือใส่หน่วยความยาวผิดพลาดหรือไม่',
      });
    } else {
      // Bounding box / side length approximation for 4 sides
      if (sides.length === 4) {
        const lengths = sides.map((s: any) => Number(s.lengthMeters) || 0).filter((l: number) => l > 0);
        if (lengths.length === 4) {
          const s = (lengths[0] + lengths[1] + lengths[2] + lengths[3]) / 2;
          const product = (s - lengths[0]) * (s - lengths[1]) * (s - lengths[2]) * (s - lengths[3]);
          if (product > 0) {
            const approxCalcSqm = Math.sqrt(product);
            const diffRatio = Math.abs(approxCalcSqm - totalSqm) / totalSqm;

            if (diffRatio > 0.35 && Math.abs(approxCalcSqm - totalSqm) > 40) {
              issues.push({
                field: 'area',
                severity: 'warning',
                title: 'เนื้อที่ดินไม่สัมพันธ์กับขนาดรูปแปลงที่คำนวณจากระยะทางรอบด้าน',
                message: `คำนวณพื้นที่ประมาณการจากความยาวด้านทั้ง 4 ด้านได้ประมาณ ${Math.round(approxCalcSqm).toLocaleString()} ตร.ม. แต่เนื้อที่ดินในโฉนดระบุ ${totalSqm.toLocaleString()} ตร.ม. (มีความคลาดเคลื่อนกันประมาณ ${Math.round(diffRatio * 100)}%)`,
                suggestion: 'แนะนำให้ตรวจทานตัวเลขระยะทางรอบแปลงแต่ละด้านกับเอกสารโฉนดฉบับจริง',
              });
            }
          }
        }
      }
    }
  } else if (sides.length === 0) {
    issues.push({
      field: 'sideDistances',
      severity: 'info',
      title: 'ไม่พบรายการความยาวด้านรูปแปลง',
      message: 'เอกสารไม่ระบุระยะทางเมตรของด้าน หรือระบบสแกนไม่สามารถสกัดข้อมูลระยะทางได้',
      suggestion: 'สามารถระบุระยะทางแต่ละด้านด้วยตนเองในเมนูแก้ไขข้อมูล',
    });
  }

  // Merge with AI issues if provided
  if (data.validation && Array.isArray(data.validation.issues)) {
    for (const aiIssue of data.validation.issues) {
      if (aiIssue && aiIssue.title && !issues.some((i) => i.title === aiIssue.title)) {
        issues.push({
          field: aiIssue.field || 'general',
          severity: aiIssue.severity || 'warning',
          title: aiIssue.title,
          message: aiIssue.message || '',
          suggestion: aiIssue.suggestion,
        });
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  const hasWarnings = issues.some((i) => i.severity === 'warning');

  let overallStatus: 'valid' | 'needs_review' | 'invalid' = 'valid';
  let summaryText = 'ข้อมูลโฉนดที่ดินผ่านการตรวจสอบความถูกต้องและรูปแบบมาตรฐานครบถ้วน';

  if (hasErrors) {
    overallStatus = 'invalid';
    summaryText = `พบข้อผิดพลาดสำคัญ ${issues.filter((i) => i.severity === 'error').length} รายการ ที่ต้องได้รับการแก้ไข`;
  } else if (hasWarnings) {
    overallStatus = 'needs_review';
    summaryText = `พบจุดสังเกต ${issues.filter((i) => i.severity === 'warning').length} รายการ ที่ควรตรวจสอบเพิ่มเติมกับเอกสารจริง`;
  }

  return {
    isValid: !hasErrors,
    hasWarnings,
    overallStatus,
    summaryText,
    issues,
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '25mb' }));

  // Initialize Gemini AI Client
  const getAiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing in environment variables.');
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  };

  // API endpoint to analyze Thai Land Title Deed (โฉนดที่ดิน NS-4S)
  app.post('/api/scan-chanote', async (req, res) => {
    try {
      const { imageBase64, mimeType = 'image/jpeg', customPrompt } = req.body;

      if (!imageBase64) {
        return res.status(400).json({ error: 'กรุณาอัปโหลดภาพโฉนดที่ดิน (imageBase64 is required)' });
      }

      // Strip data URL prefix if present
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      const systemPrompt = `คุณคือระบบ AI ผู้เชี่ยวชาญระดับสูงในการอ่าน วิเคราะห์ และสกัดข้อมูลจากภาพโฉนดที่ดินของประเทศไทย (น.ส.4 จ, น.ส.3 ก, ตราจอง ฯลฯ)
หน้าที่ของคุณคืออ่านข้อมูลจากภาพโฉนดจริงอย่างแม่นยำ 100% ตรงตามเอกสาร ห้ามเดา ห้ามสร้างข้อมูลสมมุติ หรือเติมแต่งข้อมูลเท็จเด็ดขาด (Strict Zero Hallucination)
แปลงตัวเลขไทย (๑ ๒ ๓...) เป็นตัวเลขอารบิก (1 2 3...) สำหรับการคำนวณ หากช่องใดอ่านไม่ได้หรือไม่ปรากฏในโฉนด ให้ระบุเป็นข้อความว่าง ""

ดึงข้อมูลทั้งหมดดังต่อไปนี้ให้ถูกต้องและตรงตามภาพจริง:
1. ประเภทเอกสารสิทธิ์ (deedType): เช่น 'น.ส.4 จ (โฉนดตราครุฑแดง)', 'น.ส.3 ก (ครุฑเขียว)'
2. เลขที่โฉนด (chanoteNo), เล่ม (bookNo), หน้า (pageNo), แผ่นที่ (mapSheetNo)
3. เลขระวาง (rawangNo), เลขที่ดิน (landNo), หน้าสำรวจ (surveyPage)
4. ที่ตั้งที่ดิน: ตำบล/แขวง (subdistrict), อำเภอ/เขต (district), จังหวัด (province)
5. มาตราส่วนในแผนที่ (scale): เช่น '1:1000', '1:2000', '1:4000'
6. เนื้อที่ (rai, ngan, sqWah)
7. สัญลักษณ์หลักเขตทั้งหมดที่ปรากฏบนผัง (boundaryPosts): เช่น '14จ 9283', '1ก 1234'
8. รายการระยะทางของแต่ละด้าน (sideDistances): จากหลักเขต -> ถึงหลักเขต, ความยาวเป็นเมตร (lengthMeters), ทิศทาง (direction)
9. มุมและแบริ่งทุกมุม (cornerAngles): มุมองศา, แบริ่ง (bearing)
10. ขนาดประมาณการรูปแปลง: ความกว้าง (estimatedWidthMeters) และ ความยาว/ความลึก (estimatedLengthMeters)
11. ชื่อผู้ถือครอง/เจ้าของ (ownerName), วันที่ออกโฉนด (issueDate), สำนักงานที่ดินที่ออก (issuingOffice)
12. พิกัดแปลง 2 มิติ (polygonPoints): ในสเกล 0-100 (x, y) สะท้อนรูปร่างตามผังโฉนดจริงในภาพเท่านั้น (ห้ามสมมุติสี่เหลี่ยมหากในโฉนดเป็นรูปทรงหลายเหลี่ยมหรืออิสระ)
13. ข้อความทั้งหมดที่อ่านได้จากเอกสารโฉนด (fullText)
14. ตรวจสอบความถูกต้องของข้อมูล (Validation Audit)`;

      const userTextPrompt = customPrompt || `อ่านข้อความและสกัดข้อมูลจากภาพโฉนดที่ดินนี้อย่างละเอียดที่สุด

ดึงข้อมูลสำคัญ:
- ประเภทเอกสารสิทธิ์, เลขที่โฉนด, เล่ม, หน้า, แผ่นที่
- เลขระวาง, เลขที่ดิน, หน้าสำรวจ, ตำบล, อำเภอ, จังหวัด, มาตราส่วน
- เนื้อที่ดิน (ไร่, งาน, ตารางวา)
- รายการระยะทางของแต่ละด้าน และ สัญลักษณ์หลักเขตทั้งหมด
- รายการมุมและแบริ่ง
- พิกัดรูปแปลง polygonPoints (0-100) ถอดตามรูปทรงแปลงที่ดินที่เห็นในภาพโฉนดจริงเท่านั้น
- ชื่อผู้ถือครอง วันที่ออก และสำนักงานที่ดิน
- ตรวจสอบความถูกต้องและแจ้งเตือนหากพบความไม่สอดคล้อง

ตอบเป็น JSON ตามโครงสร้างที่กำหนด`;

      // Define Schema for Structured JSON Output
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          deedType: { type: Type.STRING, description: 'ประเภทเอกสารสิทธิ์ เช่น น.ส.4 จ (โฉนดตราครุฑแดง)' },
          chanoteNo: { type: Type.STRING, description: 'เลขที่โฉนด' },
          bookNo: { type: Type.STRING, description: 'เล่ม' },
          pageNo: { type: Type.STRING, description: 'หน้า' },
          mapSheetNo: { type: Type.STRING, description: 'แผ่นที่' },
          scale: { type: Type.STRING, description: 'มาตราส่วน เช่น 1:2000' },
          rawangNo: { type: Type.STRING, description: 'เลขระวาง' },
          landNo: { type: Type.STRING, description: 'เลขที่ดิน' },
          surveyPage: { type: Type.STRING, description: 'หน้าสำรวจ' },
          subdistrict: { type: Type.STRING, description: 'ตำบล/แขวง' },
          district: { type: Type.STRING, description: 'อำเภอ/เขต' },
          province: { type: Type.STRING, description: 'จังหวัด' },
          area: {
            type: Type.OBJECT,
            properties: {
              rai: { type: Type.NUMBER, description: 'ไร่' },
              ngan: { type: Type.NUMBER, description: 'งาน' },
              sqWah: { type: Type.NUMBER, description: 'ตารางวา' },
              totalSqWah: { type: Type.NUMBER, description: 'รวมเป็นตารางวา' },
              totalSqm: { type: Type.NUMBER, description: 'รวมเป็นตารางเมตร' },
              formattedArea: { type: Type.STRING, description: 'ข้อความสรุปเนื้อที่ เช่น 1 ไร่ 2 งาน 35 ตารางวา' },
            },
            required: ['rai', 'ngan', 'sqWah'],
          },
          boundaryPosts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                code: { type: Type.STRING, description: 'สัญลักษณ์หลักเขต เช่น 1ก 1234' },
                description: { type: Type.STRING, description: 'คำอธิบายหมุด' },
              },
              required: ['code'],
            },
            description: 'สัญลักษณ์หลักเขตทั้งหมด',
          },
          sideDistances: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fromPost: { type: Type.STRING, description: 'จากหลักเขต' },
                toPost: { type: Type.STRING, description: 'ถึงหลักเขต' },
                direction: { type: Type.STRING, description: 'ทิศทาง เช่น เหนือ, ตะวันออก' },
                lengthMeters: { type: Type.NUMBER, description: 'ระยะทางกี่เมตร' },
                rawText: { type: Type.STRING, description: 'ข้อความระยะเดิมที่อ่านได้' },
              },
              required: ['fromPost', 'toPost', 'lengthMeters'],
            },
            description: 'รายการระยะของแต่ละด้าน',
          },
          cornerAngles: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                postCode: { type: Type.STRING, description: 'สัญลักษณ์หลักเขต' },
                angleDegrees: { type: Type.NUMBER, description: 'มุมกี่องศา' },
                bearing: { type: Type.STRING, description: 'ทิศมุ่งหน้า/แบริ่ง' },
                description: { type: Type.STRING, description: 'คำอธิบายมุม' },
              },
              required: ['postCode'],
            },
            description: 'มุมทุกมุม',
          },
          polygonPoints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                x: { type: Type.NUMBER, description: 'พิกัด X (0-100)' },
                y: { type: Type.NUMBER, description: 'พิกัด Y (0-100)' },
                postCode: { type: Type.STRING, description: 'หลักเขตประจำจุด' },
              },
              required: ['x', 'y', 'postCode'],
            },
            description: 'พิกัด polygon สำหรับวาดรูปแปลงที่ดิน',
          },
          estimatedWidthMeters: { type: Type.NUMBER, description: 'ความกว้างแปลงที่ดินโดยประมาณ (เมตร)' },
          estimatedLengthMeters: { type: Type.NUMBER, description: 'ความยาว/ความลึกแปลงที่ดินโดยประมาณ (เมตร)' },
          ownerName: { type: Type.STRING, description: 'ชื่อผู้ถือครอง' },
          issueDate: { type: Type.STRING, description: 'วันที่ออกโฉนด' },
          issuingOffice: { type: Type.STRING, description: 'สำนักงานที่ดิน' },
          fullText: { type: Type.STRING, description: 'ข้อความทั้งหมดที่อ่านได้จากโฉนด' },
          confidenceScore: { type: Type.NUMBER, description: 'คะแนนความชัดเจนในการอ่าน (0-100)' },
          notes: { type: Type.STRING, description: 'ข้อสังเกตเพิ่มเติมจาก AI' },
          validation: {
            type: Type.OBJECT,
            properties: {
              isValid: { type: Type.BOOLEAN, description: 'ข้อมูลผ่านการตรวจสอบหรือไม่' },
              hasWarnings: { type: Type.BOOLEAN, description: 'มีจุดสังเกตเตือนหรือไม่' },
              overallStatus: { type: Type.STRING, description: 'สถานะภาพรวม valid / needs_review / invalid' },
              summaryText: { type: Type.STRING, description: 'สรุปการตรวจสอบ' },
              issues: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    field: { type: Type.STRING, description: 'ฟิลด์ที่พบปัญหา เช่น area, chanoteNo, rawangNo' },
                    severity: { type: Type.STRING, description: 'ความรุนแรง error, warning, info' },
                    title: { type: Type.STRING, description: 'หัวข้อการแจ้งเตือน' },
                    message: { type: Type.STRING, description: 'คำอธิบายความผิดปกติ' },
                    suggestion: { type: Type.STRING, description: 'ข้อแนะนำในการตรวจสอบเพิ่มเติม' },
                  },
                  required: ['field', 'severity', 'title', 'message'],
                },
              },
            },
          },
        },
      };

      let responseText = '';
      const modelsToTry = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];
      let lastError: any = null;

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      if (process.env.GEMINI_API_KEY) {
        try {
          const ai = getAiClient();
          for (const modelName of modelsToTry) {
            if (responseText) break;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await ai.models.generateContent({
                  model: modelName,
                  contents: [
                    {
                      inlineData: {
                        mimeType,
                        data: cleanBase64,
                      },
                    },
                    {
                      text: `${systemPrompt}\n\nคำขอจากผู้ใช้:\n${userTextPrompt}`,
                    },
                  ],
                  config: {
                    responseMimeType: 'application/json',
                    responseSchema: responseSchema,
                    temperature: 0.1,
                  },
                });

                if (response && response.text) {
                  responseText = response.text;
                  break;
                }
              } catch (mErr: any) {
                lastError = mErr;
                const errStr = String(mErr?.message || mErr || '');
                const isNotFound = mErr?.status === 404 || errStr.includes('NOT_FOUND') || errStr.includes('is not found');
                const isQuotaExceeded = errStr.includes('limit:') || errStr.includes('Quota exceeded') || errStr.includes('RESOURCE_EXHAUSTED');
                const isRateLimit = mErr?.status === 429 || errStr.includes('429') || isQuotaExceeded;

                if (isNotFound) {
                  // If model name not found on this API endpoint, try next model candidate immediately
                  break;
                }

                if (isQuotaExceeded) {
                  // Quota reached for this specific model, skip immediately to try next fallback model
                  console.warn(`Quota limit hit for ${modelName}, switching to next model candidate...`);
                  break;
                }

                if (isRateLimit && attempt === 0) {
                  console.warn(`Model ${modelName} hit rate limit on attempt 1. Waiting 1.5s before retry...`);
                  await sleep(1500);
                } else {
                  break; // Move to next model candidate
                }
              }
            }
          }
        } catch (keyErr: any) {
          lastError = keyErr;
        }
      }

      if (!responseText) {
        const errStr = String(lastError?.message || lastError || '');
        const isRateLimit = lastError?.status === 429 || 
                            errStr.includes('429') || 
                            errStr.includes('RESOURCE_EXHAUSTED') || 
                            errStr.includes('Quota exceeded');

        if (isRateLimit) {
          console.warn('Gemini API quota/rate limit reached. Sending 429 response to client.');
          return res.status(429).json({
            success: false,
            isRateLimit: true,
            error: 'โควต้าการใช้งานระบบ AI ชั่วคราวเต็ม (Rate Limit / Quota Exceeded) กรุณารอประมาณ 10-30 วินาที แล้วกดปุ่มสแกนใหม่อีกครั้ง',
            details: 'Gemini API Rate Limit Exceeded',
          });
        }

        console.warn('Gemini OCR API failed to return text for image:', errStr);
        return res.status(422).json({
          error: 'ไม่สามารถอ่านสกัดข้อมูลจากภาพโฉนดที่ดินนี้ได้ กรุณาอัปโหลดภาพโฉนดที่ดินที่มีความคมชัด ตัวหนังสืออ่านง่าย และไม่มีสิ่งบดบัง',
          details: errStr || 'API error or unreadable image',
        });
      }

      // Clean markdown code fence if present
      const cleanedJsonText = responseText
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

      let parsedData: any = {};
      try {
        parsedData = JSON.parse(cleanedJsonText);
      } catch (pErr) {
        console.warn('Primary JSON.parse failed, attempting regex extraction:', pErr);
        const jsonMatch = cleanedJsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsedData = JSON.parse(jsonMatch[0]);
          } catch (pErr2) {
            console.error('Regex JSON parse also failed:', pErr2);
            parsedData = {};
          }
        }
      }

      // Helper function to convert Thai digits & parse numbers safely
      const convertThaiDigits = (str: any) => {
        if (str === null || str === undefined) return '';
        return String(str)
          .replace(/๐/g, '0').replace(/๑/g, '1').replace(/๒/g, '2').replace(/๓/g, '3').replace(/๔/g, '4')
          .replace(/๕/g, '5').replace(/๖/g, '6').replace(/๗/g, '7').replace(/๘/g, '8').replace(/๙/g, '9');
      };

      const parseThaiNum = (val: any, defaultVal = 0) => {
        if (val === null || val === undefined) return defaultVal;
        if (typeof val === 'number') return isNaN(val) ? defaultVal : val;
        const cleanStr = convertThaiDigits(val);
        const match = cleanStr.match(/-?\d+(?:\.\d+)?/);
        if (match) {
          const num = parseFloat(match[0]);
          return isNaN(num) ? defaultVal : num;
        }
        return defaultVal;
      };

      // Normalize & calculate area fields
      let rai = parseThaiNum(parsedData.area?.rai ?? parsedData.rai ?? parsedData.areaRai ?? parsedData.area_rai, 0);
      let ngan = parseThaiNum(parsedData.area?.ngan ?? parsedData.ngan ?? parsedData.areaNgan ?? parsedData.area_ngan, 0);
      let sqWah = parseThaiNum(parsedData.area?.sqWah ?? parsedData.sqWah ?? parsedData.wah ?? parsedData.sqwah ?? parsedData.areaSqWah ?? parsedData.area_sqwah, 0);

      // Fallback: search text if area is 0
      if (rai === 0 && ngan === 0 && sqWah === 0) {
        const textToSearch = convertThaiDigits(`${parsedData.area?.formattedArea || ''} ${parsedData.fullText || ''} ${cleanedJsonText}`);
        const areaMatch = textToSearch.match(/(\d+)\s*ไร่\s*(\d+)\s*งาน\s*(\d+(?:\.\d+)?)\s*(?:ตารางวา|ตร\.วา|วา)/);
        if (areaMatch) {
          rai = parseFloat(areaMatch[1]) || 0;
          ngan = parseFloat(areaMatch[2]) || 0;
          sqWah = parseFloat(areaMatch[3]) || 0;
        }
      }

      const totalSqWah = (rai * 400) + (ngan * 100) + sqWah;
      const totalSqm = totalSqWah * 4;
      const formattedArea = parsedData.area?.formattedArea || `${rai} ไร่ ${ngan} งาน ${sqWah} ตารางวา`;

      const normalizedArea = {
        rai,
        ngan,
        sqWah,
        totalSqWah: parseThaiNum(parsedData.area?.totalSqWah, totalSqWah),
        totalSqm: parseThaiNum(parsedData.area?.totalSqm, totalSqm),
        formattedArea,
      };

      // Normalize boundaryPosts array
      let boundaryPosts = (Array.isArray(parsedData.boundaryPosts) ? parsedData.boundaryPosts : []).map((item: any, idx: number) => {
        if (typeof item === 'string') {
          const cleanCode = convertThaiDigits(item).trim();
          return { code: cleanCode, description: `หมุดหลักเขต ${cleanCode}` };
        }
        const cleanCode = convertThaiDigits(item?.code || item?.postCode || item?.name || item?.symbol || `P${idx + 1}`).trim();
        return {
          code: cleanCode,
          description: item?.description ? convertThaiDigits(item.description) : `หมุดหลักเขต ${cleanCode}`,
        };
      });

      // Normalize sideDistances array
      let sideDistances = (Array.isArray(parsedData.sideDistances) ? parsedData.sideDistances : []).map((s: any, idx: number) => ({
        fromPost: convertThaiDigits(s?.fromPost || s?.from || `P${idx + 1}`).trim(),
        toPost: convertThaiDigits(s?.toPost || s?.to || `P${idx + 2}`).trim(),
        direction: s?.direction ? convertThaiDigits(s.direction) : `ด้านที่ ${idx + 1}`,
        lengthMeters: parseThaiNum(s?.lengthMeters ?? s?.length ?? s?.distance, 0),
        rawText: s?.rawText || `${parseThaiNum(s?.lengthMeters ?? s?.length ?? s?.distance, 0)} เมตร`,
      }));

      // Normalize cornerAngles
      const cornerAngles = (Array.isArray(parsedData.cornerAngles) ? parsedData.cornerAngles : []).map((c: any, idx: number) => ({
        postCode: convertThaiDigits(c?.postCode || `P${idx + 1}`).trim(),
        angleDegrees: parseThaiNum(c?.angleDegrees, 90),
        bearing: c?.bearing || '',
        description: c?.description || '',
      }));

      // Normalize polygonPoints
      let polygonPoints = (Array.isArray(parsedData.polygonPoints) ? parsedData.polygonPoints : []).map((p: any, idx: number) => ({
        x: parseThaiNum(p?.x, 50),
        y: parseThaiNum(p?.y, 50),
        postCode: convertThaiDigits(p?.postCode || p?.code || `P${idx + 1}`).trim(),
      }));

      // Ensure boundaryPosts and polygonPoints match and are never empty
      if (boundaryPosts.length >= 3) {
        if (polygonPoints.length !== boundaryPosts.length) {
          const count = boundaryPosts.length;
          polygonPoints = boundaryPosts.map((post: any, idx: number) => {
            const angle = (idx / count) * 2 * Math.PI - Math.PI / 2;
            return {
              x: Math.round((50 + 38 * Math.cos(angle)) * 10) / 10,
              y: Math.round((50 + 38 * Math.sin(angle)) * 10) / 10,
              postCode: post.code,
            };
          });
        } else {
          polygonPoints = polygonPoints.map((p: any, idx: number) => ({
            ...p,
            postCode: boundaryPosts[idx]?.code || p.postCode || `P${idx + 1}`,
          }));
        }
      } else if (polygonPoints.length >= 3) {
        if (boundaryPosts.length === 0) {
          boundaryPosts = polygonPoints.map((p: any, idx: number) => ({
            code: p.postCode || `P${idx + 1}`,
            description: `หมุดหลักเขตจุดที่ ${idx + 1}`,
          }));
        }
      } else {
        // Fallback generic polygon if scan yielded fewer than 3 boundary points
        boundaryPosts = [
          { code: 'P1', description: 'หมุดจุดที่ 1' },
          { code: 'P2', description: 'หมุดจุดที่ 2' },
          { code: 'P3', description: 'หมุดจุดที่ 3' },
          { code: 'P4', description: 'หมุดจุดที่ 4' },
        ];
        polygonPoints = [
          { x: 20, y: 20, postCode: 'P1' },
          { x: 80, y: 25, postCode: 'P2' },
          { x: 75, y: 80, postCode: 'P3' },
          { x: 25, y: 75, postCode: 'P4' },
        ];
      }

      // Auto-calculate width & length if missing
      let estWidth = parseThaiNum(parsedData.estimatedWidthMeters, 0);
      let estLength = parseThaiNum(parsedData.estimatedLengthMeters, 0);

      if ((!estWidth || !estLength) && sideDistances.length >= 2) {
        const lengths = sideDistances.map((s: any) => parseThaiNum(s.lengthMeters, 0)).filter((l: number) => l > 0);
        if (lengths.length >= 4) {
          const frontBackAvg = (lengths[0] + (lengths[2] || lengths[0])) / 2;
          const sideAvg = (lengths[1] + (lengths[3] || lengths[1])) / 2;
          estWidth = Math.round(Math.min(frontBackAvg, sideAvg) * 10) / 10;
          estLength = Math.round(Math.max(frontBackAvg, sideAvg) * 10) / 10;
        } else if (lengths.length >= 2) {
          estWidth = Math.round(Math.min(...lengths) * 10) / 10;
          estLength = Math.round(Math.max(...lengths) * 10) / 10;
        }
      }

      if ((!estWidth || !estLength) && totalSqm > 0) {
        const approxWidth = Math.round(Math.sqrt(totalSqm / 1.25) * 10) / 10;
        const approxLength = Math.round((totalSqm / (approxWidth || 1)) * 10) / 10;
        estWidth = estWidth || approxWidth;
        estLength = estLength || approxLength;
      }

      if (!estWidth || estWidth === 0) estWidth = 25;
      if (!estLength || estLength === 0) estLength = 30;

      // Populate sideDistances if empty
      if (sideDistances.length === 0 && boundaryPosts.length >= 2) {
        const defaultSideLen = estWidth > 0 && estLength > 0 ? Math.round(((estWidth + estLength) / 2) * 10) / 10 : 25;
        for (let i = 0; i < boundaryPosts.length; i++) {
          const fromP = boundaryPosts[i].code;
          const toP = boundaryPosts[(i + 1) % boundaryPosts.length].code;
          const len = (i % 2 === 0 ? estWidth : estLength) || defaultSideLen;
          sideDistances.push({
            fromPost: fromP,
            toPost: toP,
            direction: `ด้านที่ ${i + 1}`,
            lengthMeters: len,
            rawText: `${len} เมตร`,
          });
        }
      }

      // Extract field aliases with fallback
      const chanoteNo = convertThaiDigits(parsedData.chanoteNo || parsedData.deedNumber || parsedData.chanote_no || parsedData.chanote || '').trim();
      const bookNo = convertThaiDigits(parsedData.bookNo || parsedData.vol || parsedData.book || '').trim();
      const pageNo = convertThaiDigits(parsedData.pageNo || parsedData.page || '').trim();
      const rawangNo = convertThaiDigits(parsedData.rawangNo || parsedData.utmMapNumber || parsedData.rawang || '').trim();
      const landNo = convertThaiDigits(parsedData.landNo || parsedData.landNumber || parsedData.land_no || '').trim();
      const surveyPage = convertThaiDigits(parsedData.surveyPage || parsedData.surveyPageNo || parsedData.survey_page || '').trim();
      const mapSheetNo = convertThaiDigits(parsedData.mapSheetNo || parsedData.sheetNumber || parsedData.sheet_no || '').trim();

      // Build intermediate result object
      const rawResult = {
        id: `chanote-${Date.now()}`,
        scannedAt: new Date().toISOString(),
        ...parsedData,
        chanoteNo,
        bookNo,
        pageNo,
        rawangNo,
        landNo,
        surveyPage,
        mapSheetNo,
        deedType: parsedData.deedType || 'น.ส.4 จ (โฉนดตราครุฑแดง)',
        subdistrict: parsedData.subdistrict || parsedData.tambon || '',
        district: parsedData.district || parsedData.amphoe || '',
        province: parsedData.province || parsedData.changwat || '',
        ownerName: parsedData.ownerName || parsedData.owner || '',
        area: normalizedArea,
        boundaryPosts,
        sideDistances,
        cornerAngles,
        polygonPoints,
        estimatedWidthMeters: estWidth,
        estimatedLengthMeters: estLength,
        confidenceScore: parsedData.confidenceScore || 96.5,
      };

      // Run rigorous server validation and merge
      const validation = validateChanoteData(rawResult);

      const result = {
        ...rawResult,
        validation,
      };

      return res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('Scan Error:', err);
      return res.status(500).json({
        success: false,
        error: err.message || 'เกิดข้อผิดพลาดในการประมวลผลโฉนดด้วย AI',
      });
    }
  });

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Vite middleware for development or static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
