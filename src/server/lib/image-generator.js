import fs from 'fs-extra';
import sizeOf from 'image-size';
import Promise from 'bluebird';
import crypto from 'crypto';
import convertSvgToPng from 'convert-svg-to-png';
import cachedRequestLib from 'cached-request';
import request from 'request';
import imageToAscii from 'image-to-ascii';

import { getCloudinaryUrl } from './utils';
import { logger } from '../logger';

const WEBSITE_URL = process.env.WEBSITE_URL || "https://opencollective.com";

const cachedRequest = cachedRequestLib(request);
cachedRequest.setCacheDirectory('/tmp');

const requestPromise = Promise.promisify(cachedRequest, { multiArgs: true });

const md5 = string => crypto.createHash('md5').update(string).digest('hex');

export function generateAsciiFromImage(imgsrc, options) {

  const variants = {
    solid : '█'.split(''),
    variant1 : ' .,:;i1tfLCG08@'.split(''),
    variant2 : '@%#*+=-:. '.split('').reverse(),
    variant3 : '#¥¥®®ØØ$$ø0oo°++=-,.    '.split('').reverse(),
    variant4 : '#WMBRXVYIti+=;:,. '.split('').reverse(),
    'ultra-wide' : ('MMMMMMM@@@@@@@WWWWWWWWWBBBBBBBB000000008888888ZZZZZZZZZaZaaaaaa2222222SSS'
        +'SSSSXXXXXXXXXXX7777777rrrrrrr;;;;;;;;iiiiiiiii:::::::,:,,,,,,.........    ').split('').reverse(),
    wide : '@@@@@@@######MMMBBHHHAAAA&&GGhh9933XXX222255SSSiiiissssrrrrrrr;;;;;;;;:::::::,,,,,,,........        '.split(''),
    hatching : '##XXxxx+++===---;;,,...    '.split('').reverse(),
    bits : '# '.split('').reverse(),
    binary : '01 '.split('').reverse(),
    greyscale : ' ▤▦▩█'.split(''),
    blocks : ' ▖▚▜█'.split('')
  };

  return new Promise((resolve, reject) => {
    options.pixels = variants[options.variant || 'wide'];
    imageToAscii(imgsrc, options, (err, ascii) => {
      if (err) return reject(err);
      if (options.trim) {
        ascii = ascii.replace(/\n^\s*$/gm, '');
      }
      return resolve(ascii);
    });
  });
}

/**
 * Converts an svg string into a PNG data blob
 * (returns a promise)
 */
export function svg2png(svg) {
  const outputDir = `/tmp`;
  const outputFile = `${outputDir}/${md5(svg)}.png`;

  return fs
    // If file exists, return it
    // Note: because we generate a md5 fingerprint based on the content of the svg,
    //       any change in the svg (margin, size, number of backers, etc.) will force
    //       the creation of a new png :-)
    .readFile(outputFile)
    .catch(() =>
      // Otherwise, generate a new png (slow)
      convertSvgToPng.convert(svg)
        .then(png => fs.writeFile(outputFile, png).then(() => png))
    );
}


export function generateSVGBannerForUsers(users, options) {
  logger.debug(">>> generateSVGBannerForUsers %d users, options: %j", users.length, options);

  const {
    style, limit, collectiveSlug
  } = options;

  const imageWidth = options.width;
  const imageHeight = options.height;
  const count = Math.min(limit, users.length);

  let defaultAvatarHeight = 64;
  let defaultMargin = 5;
  if ( users.length > 50) {
    defaultAvatarHeight = 48;
    defaultMargin = 3;
  }
  if ( users.length > 150) {
    defaultAvatarHeight = 24;
    defaultMargin = 2;
  }

  const avatarHeight = Number(options.avatarHeight) || defaultAvatarHeight;
  const margin = Number(options.margin) || defaultMargin;

  const params = (style === 'rounded') ? { query: `/c_thumb,g_face,h_${avatarHeight*2},r_max,w_${avatarHeight*2},bo_3px_solid_white/c_thumb,h_${avatarHeight*2},r_max,w_${avatarHeight*2},bo_2px_solid_rgb:66C71A/e_trim/f_auto/` } : { width: avatarHeight * 2, height: avatarHeight * 2};

  const promises = [];
  for (let i = 0 ; i < count ; i++) {
    let image = users[i].image;
    if (image) {
      if (users[i].type === 'USER' || style === 'rounded') {
        image = getCloudinaryUrl(image, params);
      }
      const promiseOptions = {url: image, encoding: null, ttl: 60 * 60 * 24 * 30 * 1000}; // 30 days caching
      promises.push(requestPromise(promiseOptions));
    } else {
      promises.push(Promise.resolve());
    }
  }

  if (options.buttonImage) {
    const btn = {
      url: options.buttonImage,
      encoding: null,
      ttl: 60 * 60 * 24 * 30 * 1000
    };

    users.push({
      slug: collectiveSlug,
      website: `${WEBSITE_URL}/${collectiveSlug}#support`
    })

    promises.push(requestPromise(btn));
  }

  let posX = margin;
  let posY = margin;

  return Promise.all(promises)
    .then(responses => {
      const images = [];
      for (let i=0; i<responses.length; i++) {
        if (!responses[i]) continue;
        const { headers } = responses[i][0];
        const rawData = responses[i][1];
        const user = users[i];
        if (!user) continue;

        const contentType = headers['content-type'];
        const website = (options.linkToProfile || !user.website) ? `${WEBSITE_URL}/${user.slug}` : user.website;
        const base64data = new Buffer(rawData).toString('base64');
        let avatarWidth = avatarHeight;
        try {
          // We make sure the image loaded properly
          const dimensions = sizeOf(rawData);
          avatarWidth = Math.round(dimensions.width / dimensions.height * avatarHeight);
        } catch (e) {
          // Otherwise, we skip it
          logger.warn(`Cannot get the dimensions of the avatar of %s.`, user.slug, { image: user.image });
          continue;
        }

        if (imageWidth > 0 && posX + avatarWidth + margin > imageWidth) {
          posY += (avatarHeight + margin);
          posX = margin;
        }
        const image = `<image x="${posX}" y="${posY}" width="${avatarWidth}" height="${avatarHeight}" xlink:href="data:${contentType};base64,${base64data}"/>`;
        const imageLink = `<a xlink:href="${website.replace(/&/g,'&amp;')}" class="opencollective-svg" target="_blank" id="${user.slug}">${image}</a>`;
        images.push(imageLink);
        posX += avatarWidth + margin;
      }

      return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${imageWidth || posX}" height="${imageHeight || posY + avatarHeight + margin}">
        <style>.opencollective-svg { cursor: pointer; }</style>
        ${images.join('\n')}
      </svg>`;
    })
    .catch(e => {
      logger.error(">>> Error in image-generator:generateSVGBannerForUsers", e);
    })
  }
