import axios from 'axios';

// Cấu hình timeout mặc định cho axios (5 giây)
axios.defaults.timeout = 5000;

export default async function handler(req, res) {
  // Chỉ chấp nhận HTTP POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({ error: 'Invalid payload. Expecting { "urls": [...] }' });
  }

  const results = [];

  // Xử lý song song tất cả các video URLs gửi lên
  const promises = urls.map(async (url) => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return null;

    let videoId = extractVideoId(trimmedUrl);
    if (!videoId) {
      // Nếu là link rút gọn (vt.tiktok.com), hãy resolve nó để lấy videoId
      try {
        const resolvedUrl = await resolveRedirectUrl(trimmedUrl);
        videoId = extractVideoId(resolvedUrl);
      } catch (e) {
        return {
          url: trimmedUrl,
          videoId: '',
          creatorName: '',
          postDate: '',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          providerUsed: 'None',
          status: 'ERROR',
          errorMessage: 'Invalid TikTok URL or failed to resolve share link'
        };
      }
    }

    // Nếu vẫn không có videoId sau khi resolve
    if (!videoId) {
      return {
        url: trimmedUrl,
        videoId: '',
        creatorName: '',
        postDate: '',
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        providerUsed: 'None',
        status: 'ERROR',
        errorMessage: 'Could not extract TikTok Video ID'
      };
    }

    // Thực hiện gọi tuần tự qua các provider theo độ ưu tiên
    const providers = [
      { name: 'Ssstik', fn: fetchFromSsstik },
      { name: 'DirectHTML', fn: fetchFromDirectHTML },
      { name: 'TikWM', fn: fetchFromTikWM }
    ];

    let lastError = '';
    
    for (const provider of providers) {
      try {
        const data = await provider.fn(trimmedUrl, videoId);
        if (data) {
          return {
            url: trimmedUrl,
            videoId: videoId,
            creatorName: data.creatorName || '',
            postDate: data.postDate || '',
            views: data.views || 0,
            likes: data.likes || 0,
            comments: data.comments || 0,
            shares: data.shares || 0,
            providerUsed: provider.name,
            status: 'OK',
            errorMessage: ''
          };
        }
      } catch (e) {
        lastError += `[${provider.name}]: ${e.message}; `;
      }
    }

    // Nếu tất cả provider đều thất bại
    return {
      url: trimmedUrl,
      videoId: videoId,
      creatorName: '',
      postDate: '',
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      providerUsed: 'None',
      status: 'ERROR',
      errorMessage: lastError || 'All providers failed to extract metrics'
    };
  });

  const resolvedResults = await Promise.all(promises);
  res.status(200).json(resolvedResults.filter(Boolean));
}

// --------------------- HELPERS & PROVIDERS ---------------------

// Helper: Trích xuất Video ID từ URL
function extractVideoId(url) {
  const regex = /\/video\/(\d+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Helper: Resolve link rút gọn (vt.tiktok.com) để tìm URL gốc
async function resolveRedirectUrl(url) {
  const response = await axios.get(url, {
    maxRedirects: 0,
    validateStatus: (status) => status >= 300 && status < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
    }
  });
  return response.headers.location || url;
}

// Đệ quy tìm một Key cụ thể trong Object lồng nhau
function findKeyInObject(obj, key) {
  if (obj && typeof obj === 'object') {
    if (key in obj) {
      return obj[key];
    }
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        const found = findKeyInObject(obj[k], key);
        if (found !== undefined) {
          return found;
        }
      }
    }
  }
  return undefined;
}

// Định dạng ngày sang YYYY-MM-DD
function formatDate(timestampInSeconds) {
  if (!timestampInSeconds) return '';
  const date = new Date(timestampInSeconds * 1000);
  const year = date.getFullYear();
  let month = date.getMonth() + 1;
  let day = date.getDate();
  if (month < 10) month = `0${month}`;
  if (day < 10) day = `0${day}`;
  return `${year}-${month}-${day}`;
}

// 1. PROVIDER A: Ssstik Scraper
async function fetchFromSsstik(videoUrl) {
  // Ssstik yêu cầu POST tới https://ssstik.io/abc?url=dl
  const response = await axios.post(
    'https://ssstik.io/abc?url=dl',
    new URLSearchParams({
      id: videoUrl,
      locale: 'en',
      tt: '0' // Tham số mặc định thường được chấp nhận
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'hx-request': 'true',
        'hx-target': 'target',
        'hx-current-url': 'https://ssstik.io/en'
      }
    }
  );

  const html = response.data;

  // Lấy tên Creator
  const creatorMatch = html.match(/<h2[^>]*>@([^<]+)<\/h2>/) || html.match(/class="main-author">@([^<]+)</);
  if (!creatorMatch) {
    throw new Error('Creator Name not found in Ssstik output');
  }
  const creatorName = creatorMatch[1].trim();

  // Ssstik chủ yếu trả về nút tải và tên tác giả. 
  // Vì ssstik không hiển thị số liệu tương tác (views, likes, comments, shares) trên trang tải về,
  // chúng ta ném lỗi để tự động chuyển sang Provider DirectHTML hoặc TikWM để lấy đầy đủ metrics.
  // Điều này đảm bảo tính năng fallback hoạt động đúng mong đợi!
  throw new Error('Ssstik lacks engagement metrics (falling back to get views/likes)');
}

// 2. PROVIDER B: Direct HTML TikTok Parser
async function fetchFromDirectHTML(videoUrl) {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  ];
  // Chọn ngẫu nhiên User-Agent
  const selectedUA = userAgents[Math.floor(Math.random() * userAgents.length)];

  const response = await axios.get(videoUrl, {
    headers: {
      'User-Agent': selectedUA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
      'Cache-Control': 'no-cache'
    }
  });

  const html = response.data;

  // Cách 1: Parse __UNIVERSAL_DATA_FOR_REHYDRATION__
  const rehydrationMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (rehydrationMatch && rehydrationMatch[1]) {
    const jsonObj = JSON.parse(rehydrationMatch[1].trim());
    const itemStruct = findKeyInObject(jsonObj, 'itemStruct');
    if (itemStruct) {
      return {
        creatorName: itemStruct.author ? itemStruct.author.uniqueId : '',
        postDate: formatDate(itemStruct.createTime),
        views: itemStruct.stats ? itemStruct.stats.playCount : 0,
        likes: itemStruct.stats ? itemStruct.stats.diggCount : 0,
        comments: itemStruct.stats ? itemStruct.stats.commentCount : 0,
        shares: itemStruct.stats ? itemStruct.stats.shareCount : 0
      };
    }
  }

  // Cách 2: Parse SIGI_STATE
  const sigiMatch = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (sigiMatch && sigiMatch[1]) {
    const sigiObj = JSON.parse(sigiMatch[1].trim());
    const itemModule = findKeyInObject(sigiObj, 'ItemModule');
    if (itemModule) {
      const keys = Object.keys(itemModule);
      if (keys.length > 0) {
        const videoInfo = itemModule[keys[0]];
        return {
          creatorName: videoInfo.author,
          postDate: formatDate(videoInfo.createTime),
          views: videoInfo.stats ? videoInfo.stats.playCount : 0,
          likes: videoInfo.stats ? videoInfo.stats.diggCount : 0,
          comments: videoInfo.stats ? videoInfo.stats.commentCount : 0,
          shares: videoInfo.stats ? videoInfo.stats.shareCount : 0
        };
      }
    }
  }

  throw new Error('Failed to extract JSON script tags from HTML source');
}

// 3. PROVIDER C: TikWM API
async function fetchFromTikWM(videoUrl) {
  const response = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const json = response.data;
  if (json && json.code === 0 && json.data) {
    const data = json.data;
    return {
      creatorName: data.author ? data.author.unique_id : '',
      postDate: formatDate(data.create_time),
      views: data.play_count || 0,
      likes: data.digg_count || 0,
      comments: data.comment_count || 0,
      shares: data.share_count || 0
    };
  }

  throw new Error(json ? json.msg : 'Empty TikWM JSON response');
}
