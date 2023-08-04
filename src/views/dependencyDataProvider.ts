// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as _ from "lodash";
import {
    commands, Event, EventEmitter, ExtensionContext, ProviderResult,
    RelativePattern, TreeDataProvider, TreeItem, Uri, window, workspace,
} from "vscode";
import { instrumentOperationAsVsCodeCommand, sendError } from "vscode-extension-telemetry-wrapper";
import { contextManager } from "../../extension.bundle";
import { Commands } from "../commands";
import { Context } from "../constants";
import { appendOutput, executeExportJarTask } from "../tasks/buildArtifact/BuildArtifactTaskProvider";
import { Jdtls } from "../java/jdtls";
import { INodeData, NodeKind } from "../java/nodeData";
import { languageServerApiManager } from "../languageServerApi/languageServerApiManager";
import { Settings } from "../settings";
import { explorerLock } from "../utils/Lock";
import { DataNode } from "./dataNode";
import { ExplorerNode } from "./explorerNode";
import { explorerNodeCache } from "./nodeCache/explorerNodeCache";
import { ProjectNode } from "./projectNode";
import { WorkspaceNode } from "./workspaceNode";

// 修改
import * as fse from "fs-extra";
import { HierarchicalPackageNodeData } from "../java/hierarchicalPackageNodeData";
import { HierarchicalPackageNode } from "./hierarchicalPackageNode";

export class DependencyDataProvider implements TreeDataProvider<ExplorerNode> {

    private _onDidChangeTreeData: EventEmitter<ExplorerNode | null | undefined> = new EventEmitter<ExplorerNode | null | undefined>();

    // tslint:disable-next-line:member-ordering
    public onDidChangeTreeData: Event<ExplorerNode | null | undefined> = this._onDidChangeTreeData.event;

    private _rootItems: ExplorerNode[] | undefined = undefined;
    private _refreshDelayTrigger: _.DebouncedFunc<((element?: ExplorerNode) => void)>;
    /**
     * The element which is pending to be refreshed.
     * `undefined` denotes to root node.
     * `null` means no node is pending.
     */
    private pendingRefreshElement: ExplorerNode | undefined | null;

    // 修改
    private cacheRootItems: ExplorerNode[] | undefined = undefined;
    private cacheRootItemsHierarchicalView: ExplorerNode[] | undefined = undefined;
    private isFirst: boolean = false;
    private _hierarchicalPackageNodeDataMap: Map<string, HierarchicalPackageNodeData> = new Map<string, HierarchicalPackageNodeData>();

    constructor(public readonly context: ExtensionContext) {
        // 修改
        let rootItems: ExplorerNode[] = [];
        const folders = workspace.workspaceFolders;
        try{
            if (folders && folders.length) {
                if (folders.length > 1) {
                    if(Settings.isHierarchicalView()) {
                        folders.forEach(folder => {
                            let cachedFile = Uri.joinPath(folder.uri, '.vscode/explorerNodeCached_HierarchicalView.json').fsPath;
                            if(fse.pathExistsSync(cachedFile)) {
                                let data = JSON.parse(fse.readFileSync(cachedFile, "utf-8"));
                                let workspaceNode: INodeData = data["root"];
                                rootItems.push(new WorkspaceNode(workspaceNode, undefined));
                                for (let [uri, hierarchicalPackageNodeData] of Object.entries(data["hierarchicalPackageNodeDataMap"]) as any) {
                                    this._hierarchicalPackageNodeDataMap.set(uri, hierarchicalPackageNodeData);
                                }
                            }
                        });
                    }else {
                        folders.forEach(folder => {
                            let cachedFile = Uri.joinPath(folder.uri, '.vscode/explorerNodeCached.json').fsPath;
                            if(fse.pathExistsSync(cachedFile)) {
                                let workspaceNode: INodeData = JSON.parse(fse.readFileSync(cachedFile, "utf-8"));
                                rootItems.push(new WorkspaceNode(workspaceNode, undefined));
                            }
                        });
                    }
                } else {
                    if(Settings.isHierarchicalView()) {
                        let cachedFile = Uri.joinPath(folders[0].uri, '.vscode/explorerNodeCached_HierarchicalView.json').fsPath;
                        if(fse.pathExistsSync(cachedFile)) {
                            let data = JSON.parse(fse.readFileSync(cachedFile, "utf-8"));
                            let projects: INodeData[] = data["root"];
                            projects.forEach((project) => {
                                rootItems.push(new ProjectNode(project, undefined));
                            });
                            for (let [uri, hierarchicalPackageNodeData] of Object.entries(data["hierarchicalPackageNodeDataMap"]) as any) {
                                this._hierarchicalPackageNodeDataMap.set(uri, hierarchicalPackageNodeData);
                            }
                        }
                    }else {
                        let cachedFile = Uri.joinPath(folders[0].uri, '.vscode/explorerNodeCached.json').fsPath;
                        if(fse.pathExistsSync(cachedFile)) {
                            let projects: INodeData[] = JSON.parse(fse.readFileSync(cachedFile, "utf-8"));
                            projects.forEach((project) => {
                                rootItems.push(new ProjectNode(project, undefined));
                            });   
                        }
                    }
                }
            }
        }catch(e: any) {
            console.log(e.message);
            rootItems = [];
        }
        if(rootItems.length) {
            if(Settings.isHierarchicalView()) {
                this.cacheRootItemsHierarchicalView = rootItems;
            }
            else {
                this.cacheRootItems = rootItems;
            }
            this.isFirst = true;
        }


        // commands that do not send back telemetry
        context.subscriptions.push(commands.registerCommand(Commands.VIEW_PACKAGE_INTERNAL_REFRESH, (debounce?: boolean, element?: ExplorerNode) =>
            this.refresh(debounce, element)));
        context.subscriptions.push(commands.registerCommand(Commands.EXPORT_JAR_REPORT, (terminalId: string, message: string) => {
            appendOutput(terminalId, message);
        }));

        // // 修改
        // context.subscriptions.push(commands.registerCommand(Commands.VIEW_PACKAGE_DELETE_CACHE, () => {
        //     const folders = workspace.workspaceFolders;
        //     if (folders && folders.length) {
        //         let fileNames = [
        //             '.vscode/explorerNodeCached_HierarchicalView.json',
        //             '.vscode/explorerNodeCached.json'
        //         ];
        //         if (folders.length > 1) {
        //             folders.forEach(folder => {
        //                 fileNames.forEach(fileName => {
        //                     let cachedFile = Uri.joinPath(folder.uri, fileName).fsPath;
        //                     if(fse.pathExistsSync(cachedFile)) fse.removeSync(cachedFile);
        //                 })
        //             });
        //         } else {
        //             fileNames.forEach(fileName => {
        //                 let cachedFile = Uri.joinPath(folders[0].uri, fileName).fsPath;
        //             if(fse.pathExistsSync(cachedFile)) fse.removeSync(cachedFile);
        //             })
        //         }
        //     }
        //     this.cacheRootItems = undefined;
        //     this.cacheRootItemsHierarchicalView = undefined;
        //     commands.executeCommand(Commands.VIEW_PACKAGE_INTERNAL_REFRESH);
        // }));

        // normal commands
        // 修改
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.VIEW_PACKAGE_REFRESH, (debounce?: boolean, element?: ExplorerNode) =>
            {
                const folders = workspace.workspaceFolders;
                if (folders && folders.length) {
                    let fileNames = [
                        '.vscode/explorerNodeCached_HierarchicalView.json',
                        '.vscode/explorerNodeCached.json'
                    ];
                    if (folders.length > 1) {
                        folders.forEach(folder => {
                            fileNames.forEach(fileName => {
                                let cachedFile = Uri.joinPath(folder.uri, fileName).fsPath;
                                if(fse.pathExistsSync(cachedFile)) fse.removeSync(cachedFile);
                            })
                        });
                    } else {
                        fileNames.forEach(fileName => {
                            let cachedFile = Uri.joinPath(folders[0].uri, fileName).fsPath;
                        if(fse.pathExistsSync(cachedFile)) fse.removeSync(cachedFile);
                        })
                    }
                }
                this.cacheRootItems = undefined;
                this.cacheRootItemsHierarchicalView = undefined;
                this.refresh(debounce, element); 
            }));
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.VIEW_PACKAGE_EXPORT_JAR, async (node: INodeData) => {
            executeExportJarTask(node);
        }));
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.VIEW_PACKAGE_OUTLINE, (uri, range) =>
            window.showTextDocument(Uri.parse(uri), { selection: range })));
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.JAVA_PROJECT_BUILD_WORKSPACE, () =>
            commands.executeCommand(Commands.JAVA_BUILD_WORKSPACE, true /*fullCompile*/)));
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.JAVA_PROJECT_CLEAN_WORKSPACE, () =>
            commands.executeCommand(Commands.JAVA_CLEAN_WORKSPACE)));
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.JAVA_PROJECT_UPDATE, async (node: INodeData) => {
            if (!node.uri) {
                sendError(new Error("Uri not available when reloading project"));
                window.showErrorMessage("The URI of the project is not available, you can try to trigger the command 'Java: Reload Project' from Command Palette.");
                return;
            }
            const pattern: RelativePattern = new RelativePattern(Uri.parse(node.uri).fsPath, "{pom.xml,*.gradle}");
            const uris: Uri[] = await workspace.findFiles(pattern, null /*exclude*/, 1 /*maxResults*/);
            if (uris.length >= 1) {
                commands.executeCommand(Commands.JAVA_PROJECT_CONFIGURATION_UPDATE, uris[0]);
            }
        }));
        context.subscriptions.push(instrumentOperationAsVsCodeCommand(Commands.JAVA_PROJECT_REBUILD, async (node: INodeData) => {
            if (!node.uri) {
                sendError(new Error("Uri not available when building project"));
                window.showErrorMessage("The URI of the project is not available, you can try to trigger the command 'Java: Rebuild Projects' from Command Palette.");
                return;
            }
            commands.executeCommand(Commands.BUILD_PROJECT, Uri.parse(node.uri), true);
        }));

        Settings.registerConfigurationListener((updatedConfig, oldConfig) => {
            if (updatedConfig.refreshDelay !== oldConfig.refreshDelay) {
                this.setRefreshDebounceFunc(updatedConfig.refreshDelay);
            }
        });
        this.setRefreshDebounceFunc();
    }

    public refresh(debounce = false, element?: ExplorerNode) {
        if (element === undefined || this.pendingRefreshElement === undefined) {
            this._refreshDelayTrigger(undefined);
            this.pendingRefreshElement = undefined;
        } else if (this.pendingRefreshElement === null
                || element.isItselfOrAncestorOf(this.pendingRefreshElement)) {
            this._refreshDelayTrigger(element);
            this.pendingRefreshElement = element;
        } else if (this.pendingRefreshElement.isItselfOrAncestorOf(element)) {
            this._refreshDelayTrigger(this.pendingRefreshElement);
        } else {
            this._refreshDelayTrigger.flush();
            this._refreshDelayTrigger(element);
            this.pendingRefreshElement = element;
        }
        if (!debounce) { // Immediately refresh
            this._refreshDelayTrigger.flush();
        }
    }

    public setRefreshDebounceFunc(wait?: number) {
        if (!wait) {
            wait = Settings.refreshDelay();
        }
        if (this._refreshDelayTrigger) {
            this._refreshDelayTrigger.cancel();
        }
        this._refreshDelayTrigger = _.debounce(this.doRefresh, wait);
    }

    public getTreeItem(element: ExplorerNode): TreeItem | Promise<TreeItem> {
        return element.getTreeItem();
    }

    // 修改
    public async getChildren(element?: ExplorerNode): Promise<ExplorerNode[] | undefined | null> {
        languageServerApiManager.ready().then(() => {
            if(this.isFirst) {
                this.isFirst = false;
                commands.executeCommand(Commands.VIEW_PACKAGE_REFRESH);
            }
        })

        let children: ExplorerNode[] | null | undefined = undefined;
        if(Settings.isHierarchicalView()) {
            if(this.isFirst) {
                if(!this._rootItems || !element) {
                    children = this._rootItems = this.cacheRootItemsHierarchicalView;
                }else {
                    if(element instanceof HierarchicalPackageNode && element.uri) {
                        let hierarchicalPackageNodeData = this.hierarchicalPackageNodeDataMap.get(element.uri);
                        if(hierarchicalPackageNodeData) element.nodeData.children?.push(...hierarchicalPackageNodeData.children.filter(child => {
                            return child.uri? fse.existsSync(Uri.parse(child.uri).fsPath) : false;
                        }));
                    }
                    children = await (element as DataNode).getChildNodeList();
                }  
            }
            else {
                if (!await languageServerApiManager.ready()) {
                    return [];
                }
                if(this.cacheRootItemsHierarchicalView?.length){
                    if(!this._rootItems || !element) {
                        children = this._rootItems = this.cacheRootItemsHierarchicalView;
                    }else {
                        children = await element.getChildren();
                    }
                }
                else {
                    children = (!this._rootItems || !element) ? await this.getRootNodes() : await element.getChildren();
                }
                if(element instanceof HierarchicalPackageNode && element.uri) {
                    let data = <HierarchicalPackageNodeData>element.nodeData;
                    data.children = data.children?.filter(child => {
                        return !(child instanceof HierarchicalPackageNodeData);
                    })
                    this._hierarchicalPackageNodeDataMap.set(element.uri, data);
                }
            } 
        }else {
            if(this.isFirst) {
                children = (!this._rootItems || !element) ? this._rootItems = this.cacheRootItems : await (element as DataNode).getChildNodeList();
            }
            else {
                if (!await languageServerApiManager.ready()) {
                    return [];
                }
                if(this.cacheRootItems?.length){
                    children = (!this._rootItems || !element) ? this._rootItems = this.cacheRootItems : await element.getChildren();
                }
                else {
                    children = (!this._rootItems || !element) ? await this.getRootNodes() : await element.getChildren();
                }
            }
        }

        explorerNodeCache.saveNodes(children || []);
        return children;
    }

    public getParent(element: ExplorerNode): ProviderResult<ExplorerNode> {
        return element.getParent();
    }

    public async revealPaths(paths: INodeData[]): Promise<DataNode | undefined> {
        const projectNodeData = paths.shift();
        const projects = await this.getRootProjects();
        const project = projects ? <DataNode>projects.find((node: DataNode) =>
            node.path === projectNodeData?.path && node.nodeData.name === projectNodeData?.name) : undefined;
        return project?.revealPaths(paths);
    }

    public async getRootProjects(): Promise<ExplorerNode[]> {
        const rootElements = await this.getRootNodes();
        if (rootElements[0] instanceof ProjectNode) {
            return rootElements;
        } else {
            let result: ExplorerNode[] = [];
            for (const rootWorkspace of rootElements) {
                const projects = await rootWorkspace.getChildren();
                if (projects) {
                    result = result.concat(projects);
                }
            }
            return result;
        }
    }

    private doRefresh(element?: ExplorerNode): void {
        if (!element) {
            this._rootItems = undefined;
        }
        explorerNodeCache.removeNodeChildren(element);
        this._onDidChangeTreeData.fire(element);
        this.pendingRefreshElement = null;
    }

    private async getRootNodes(): Promise<ExplorerNode[]> {
        try {
            await explorerLock.acquireAsync();

            if (this._rootItems) {
                return this._rootItems;
            }

            const rootItems: ExplorerNode[] = [];
            const folders = workspace.workspaceFolders;
            if (folders && folders.length) {
                if (folders.length > 1) {
                    folders.forEach((folder) => rootItems.push(new WorkspaceNode({
                        name: folder.name,
                        uri: folder.uri.toString(),
                        kind: NodeKind.Workspace,
                    }, undefined)));
                    this._rootItems = rootItems;
                } else {
                    const result: INodeData[] = await Jdtls.getProjects(folders[0].uri.toString());
                    result.forEach((project) => {
                        rootItems.push(new ProjectNode(project, undefined));
                    });
                    this._rootItems = rootItems;
                }
            }
            contextManager.setContextValue(Context.NO_JAVA_PROJECT, _.isEmpty(rootItems));
            return rootItems;
        } finally {
            explorerLock.release();
        }
    }

    // 修改
    public get rootItems() {
        return this._rootItems;
    }

    // 修改
    public get hierarchicalPackageNodeDataMap() {
        return this._hierarchicalPackageNodeDataMap;
    }
}
