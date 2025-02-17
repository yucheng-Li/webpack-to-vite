import path from 'path'
import { parseWebpackConfig } from '../config/parse'
import { RawValue, ViteConfig } from '../config/vite'
import { TransformContext } from './context'
import { initViteConfig, Transformer, transformImporters } from './transformer'
import { DEFAULT_VUE_VERSION } from '../constants/constants'
import { Entry } from '../config/webpack'
import { isObject } from '../utils/common'
import { recordConver } from '../utils/report'
import { AstParsingResult } from '../ast-parse/astParse'
import { getVueVersion } from '../utils/version'
import { ServerOptions } from 'vite'
import { relativePathFormat } from '../utils/file'

// convert webpack.config.js => vite.config.js
export class WebpackTransformer implements Transformer {
    context : TransformContext = {
      vueVersion: DEFAULT_VUE_VERSION,
      config: initViteConfig(),
      importers: []
    }

    public async transform (rootDir: string, astParsingResult?: AstParsingResult): Promise<ViteConfig> {
      this.context.vueVersion = getVueVersion(rootDir)
      const webpackConfig = await parseWebpackConfig(path.resolve(rootDir, 'webpack.config.js'))
      transformImporters(this.context, astParsingResult)
      const config = this.context.config

      // convert base config
      // webpack may have multiple entry files, e.g.
      // 1. one entry, with one entry file : e.g. entry: './app/index.js'
      // 2. one entry, with multiple entry files: e.g. entry: ['./pc/index.js','./wap/index.js']
      // 3. multiple entries e.g. entry: {
      //      wap: './pc/index.js',
      //      pc: './wap/index.js'
      // }
      config.mode = webpackConfig.mode
      config.build = {}

      // convert entry
      if (webpackConfig.entry !== '' && webpackConfig.entry !== null) {
        config.build.rollupOptions = {}
        let input
        if (isObject(webpackConfig.entry)) {
          input = suitableFormat(webpackConfig.entry)
        } else if (typeof webpackConfig.entry === 'function') {
          input = webpackConfig.entry()
        } else {
          input = webpackConfig.entry
        }
        if (input && webpackConfig.context) {
          if (isObject(input)) {
            Object.keys(input).forEach(key => {
              const relativePath = relativePathFormat(rootDir, path.join(webpackConfig.context, input[key]))
              input[key] = new RawValue(`path.resolve(__dirname, '${relativePath}')`)
            })
          } else if (Array.isArray(input)) {
            input = input.map(item => {
              const relativePath = relativePathFormat(rootDir, path.join(webpackConfig.context, item))
              return new RawValue(`path.resolve(__dirname, '${relativePath}')`)
            })
          } else {
            const relativePath = relativePathFormat(rootDir, path.join(webpackConfig.context, input))
            input = new RawValue(`path.resolve(__dirname, '${relativePath}')`)
          }
        }
        config.build.rollupOptions.input = input
      }
      recordConver({ num: 'W01', feat: 'build input options' })
      // convert output
      if (webpackConfig.output?.path) {
        const relativePath = relativePathFormat(rootDir, webpackConfig.output.path)
        config.build.outDir = new RawValue(`path.resolve(__dirname, '${relativePath}')`)
      }
      recordConver({ num: 'W02', feat: 'outDir options' })
      // convert alias
      const defaultAlias = []
      const alias = {
        '@': `${rootDir}/src`
      }
      if (webpackConfig.resolve?.alias) {
        Object.keys(webpackConfig.resolve.alias).forEach((key) => {
          alias[key] = webpackConfig.resolve.alias[key]
        })
      }

      Object.keys(alias).forEach((key) => {
        let relativePath = relativePathFormat(rootDir, path.resolve(rootDir, alias[key]))
        if (key === 'vue$') {
          key = key.replace('$', '')
          relativePath = 'node_modules/' + relativePath
        }
        defaultAlias.push({
          find: key,
          replacement: new RawValue(`path.resolve(__dirname,'${relativePath}')`)
        })
      })
      config.resolve.alias = defaultAlias
      recordConver({ num: 'W03', feat: 'resolve.alias options' })
      // convert devServer
      if (webpackConfig.devServer) {
        config.server = this.transformDevServer(webpackConfig.devServer, rootDir)
        recordConver({ num: 'W04', feat: 'server options' })
      }
      // convert plugins
      // webpack.DefinePlugin
      if (webpackConfig.plugins && Array.isArray(webpackConfig.plugins)) {
        config.define = {}
        webpackConfig.plugins.forEach((item : any) => {
          if (item.constructor.name === 'DefinePlugin') {
            Object.keys(item).forEach((definitions) => {
              const val = item[definitions]
              Object.keys(val).forEach((variable) => {
                config.define[variable] = val[variable]
              })
            })
          }
        })
      }
      recordConver({ num: 'W05', feat: 'define options' })
      return config
    }

    public transformDevServer (devServer, rootDir): ServerOptions {
      let server: ServerOptions = {}
      server = {}
      server.strictPort = false
      server.port = Number(process.env.PORT) || devServer.port
      const host = process.env.DEV_HOST || devServer.public || devServer.host
      if (host) {
        server.host = host
          .replace('http://', '')
          .replace('https://', '')
      }
      server.open = devServer.open
      server.https = devServer.https
      const proxy = devServer.proxy
      if (typeof proxy === 'object') {
        for (const proxyKey in proxy) {
          if (Object.prototype.hasOwnProperty.call(proxy, proxyKey)) {
            const pathRewrite = proxy[proxyKey].pathRewrite
            if (!pathRewrite) {
              continue
            }
            if (typeof pathRewrite === 'object') {
              Object.keys(pathRewrite).forEach(key => {
                const content = new RegExp(key)
                const replaceContent = pathRewrite[key] || "''"
                proxy[proxyKey].rewrite = new RawValue(`(path) => path.replace(${content}, ${replaceContent})`)
              })
            }
            if (typeof pathRewrite === 'function') {
              proxy[proxyKey].rewrite = proxy[proxyKey].pathRewrite
            }
            delete proxy[proxyKey].pathRewrite
          }
        }
      }
      server.proxy = proxy
      const relativePath = relativePathFormat(rootDir, devServer.contentBase)
      // @ts-ignore
      server.base = new RawValue(`path.resolve(__dirname, '${relativePath}')`)
      return server
    }
}

function suitableFormat (entry: Entry) : Entry {
  const res : Entry = {}
  Object.keys(entry).forEach(function (name) {
    if (!Array.isArray(entry[name])) {
      res[name] = entry[name]
      return
    }
    entry[name].forEach((item, index) => {
      const key = name.concat(index)
      res[key] = item
    })
  });
  return res
}
