/**
 * RH 工具节点 - 共享数据 Context
 *
 * - 同一画布上多个 RHToolsNode 实例共享同一份「分类 + 应用」数据。
 * - 任一节点对数据的增删改，立即广播到其他节点（无需各自轮询/重新拉取）。
 * - 首次挂载时统一从后端拉取，本地维护内存副本。
 *
 * 注意：与 RH 应用创意包数据完全分开，独立 JSON 存储文件。
 */
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import {
  getRHToolCategories,
  addRHToolCategory as apiAddCategory,
  renameRHToolCategory as apiRenameCategory,
  deleteRHToolCategory as apiDeleteCategory,
  reorderRHToolCategories as apiReorderCategories,
  getRHTools,
  addRHTool as apiAddTool,
  updateRHTool as apiUpdateTool,
  deleteRHTool as apiDeleteTool,
  reorderRHTools as apiReorderTools,
  type AddRHToolPayload,
  type RHTool,
  type RHToolCategory,
} from '../services/api';

interface RHToolsContextType {
  categories: RHToolCategory[];
  tools: RHTool[];
  loading: boolean;
  reload: () => Promise<void>;

  // categories
  addCategory: (name: string) => Promise<RHToolCategory | null>;
  renameCategory: (id: string, name: string) => Promise<boolean>;
  deleteCategory: (id: string) => Promise<boolean>;
  reorderCategories: (ids: string[]) => Promise<boolean>;

  // tools
  addTool: (payload: AddRHToolPayload) => Promise<RHTool | null>;
  updateTool: (id: string, payload: Partial<AddRHToolPayload>) => Promise<RHTool | null>;
  deleteTool: (id: string) => Promise<boolean>;
  reorderTools: (ids: string[]) => Promise<boolean>;
}

const RHToolsContext = createContext<RHToolsContextType | null>(null);

export const RHToolsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [categories, setCategories] = useState<RHToolCategory[]>([]);
  const [tools, setTools] = useState<RHTool[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, tRes] = await Promise.all([getRHToolCategories(), getRHTools()]);
      if (cRes.success) setCategories(cRes.data);
      if (tRes.success) setTools(tRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const addCategory = useCallback(async (name: string) => {
    const r = await apiAddCategory(name);
    if (r.success) {
      setCategories((prev) => [...prev, r.data]);
      return r.data;
    }
    return null;
  }, []);

  const renameCategory = useCallback(async (id: string, name: string) => {
    const r = await apiRenameCategory(id, name);
    if (r.success) {
      setCategories((prev) => prev.map((c) => (c.id === id ? r.data : c)));
      return true;
    }
    return false;
  }, []);

  const deleteCategory = useCallback(async (id: string) => {
    const r = await apiDeleteCategory(id);
    if (r.success) {
      setCategories((prev) => prev.filter((c) => c.id !== id));
      setTools((prev) => prev.map((t) => (t.categoryId === id ? { ...t, categoryId: '' } : t)));
      return true;
    }
    return false;
  }, []);

  const reorderCategories = useCallback(async (ids: string[]) => {
    const r = await apiReorderCategories(ids);
    if (r.success) {
      setCategories(r.data);
      return true;
    }
    return false;
  }, []);

  const addTool = useCallback(async (payload: AddRHToolPayload) => {
    const r = await apiAddTool(payload);
    if (r.success) {
      setTools((prev) => [...prev, r.data]);
      return r.data;
    }
    return null;
  }, []);

  const updateTool = useCallback(async (id: string, payload: Partial<AddRHToolPayload>) => {
    const r = await apiUpdateTool(id, payload);
    if (r.success) {
      setTools((prev) => prev.map((t) => (t.id === id ? r.data : t)));
      return r.data;
    }
    return null;
  }, []);

  const deleteTool = useCallback(async (id: string) => {
    const r = await apiDeleteTool(id);
    if (r.success) {
      setTools((prev) => prev.filter((t) => t.id !== id));
      return true;
    }
    return false;
  }, []);

  const reorderTools = useCallback(async (ids: string[]) => {
    const r = await apiReorderTools(ids);
    if (r.success) {
      setTools(r.data);
      return true;
    }
    return false;
  }, []);

  return (
    <RHToolsContext.Provider
      value={{
        categories,
        tools,
        loading,
        reload,
        addCategory,
        renameCategory,
        deleteCategory,
        reorderCategories,
        addTool,
        updateTool,
        deleteTool,
        reorderTools,
      }}
    >
      {children}
    </RHToolsContext.Provider>
  );
};

export const useRHTools = (): RHToolsContextType => {
  const ctx = useContext(RHToolsContext);
  if (!ctx) throw new Error('useRHTools must be used within RHToolsProvider');
  return ctx;
};

/** 软依赖：组件未在 Provider 下时返回 null（节点单测/孤立渲染时用）。 */
export const useRHToolsSafe = (): RHToolsContextType | null => useContext(RHToolsContext);
